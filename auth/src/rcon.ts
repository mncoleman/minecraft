// Minimal Source-RCON client over Bun TCP. Used by the panel to push world
// access changes to the live Paper server. Commands are serialized through an
// in-process queue (one at a time) and each call connects, authenticates, runs
// one command, and closes — RCON connects are cheap and this avoids stale
// sockets for a low-frequency control plane.

const HOST = process.env.RCON_HOST || "mc-eagler";
const PORT = Number(process.env.RCON_PORT || 25575);
const PASSWORD = process.env.RCON_PASSWORD || "";

const TYPE_AUTH = 3;
const TYPE_EXEC = 2;
// (auth response is type 2; value response is type 0)
const ID_AUTH = 1;
const ID_EXEC = 2;

function buildPacket(id: number, type: number, body: string): Buffer {
  const bodyBuf = Buffer.from(body, "ascii");
  const len = 4 + 4 + bodyBuf.length + 2; // id + type + body + two NUL bytes
  const buf = Buffer.alloc(4 + len);
  buf.writeInt32LE(len, 0);
  buf.writeInt32LE(id, 4);
  buf.writeInt32LE(type, 8);
  bodyBuf.copy(buf, 12);
  // last two bytes already 0
  return buf;
}

/** Strip Minecraft §-color codes from a response. */
export function stripColor(s: string): string {
  return s.replace(/§[0-9a-fk-or]/gi, "");
}

function runOnce(command: string, timeoutMs = 5000): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!PASSWORD) return reject(new Error("RCON_PASSWORD not set"));
    let buf = Buffer.alloc(0);
    let authed = false;
    let out = "";
    let settle: ReturnType<typeof setTimeout> | null = null;
    let done = false;

    const fail = (e: Error) => { if (!done) { done = true; reject(e); } };
    const finish = (sock: any) => {
      if (done) return;
      done = true;
      try { sock.end(); } catch {}
      resolve(out);
    };

    const guard = setTimeout(() => fail(new Error("RCON timeout: " + command)), timeoutMs);

    Bun.connect({
      hostname: HOST,
      port: PORT,
      socket: {
        open(sock) {
          sock.write(buildPacket(ID_AUTH, TYPE_AUTH, PASSWORD));
        },
        data(sock, chunk) {
          buf = Buffer.concat([buf, chunk]);
          while (buf.length >= 4) {
            const len = buf.readInt32LE(0);
            if (buf.length < 4 + len) break;
            const id = buf.readInt32LE(4);
            const body = buf.toString("utf8", 12, 4 + len - 2);
            buf = buf.subarray(4 + len);
            if (!authed) {
              if (id === -1) { clearTimeout(guard); try { sock.end(); } catch {} return fail(new Error("RCON auth failed")); }
              authed = true;
              sock.write(buildPacket(ID_EXEC, TYPE_EXEC, command));
            } else {
              out += body;
              if (settle) clearTimeout(settle);
              // small debounce to gather fragmented multi-packet responses
              settle = setTimeout(() => { clearTimeout(guard); finish(sock); }, 120);
            }
          }
        },
        error(_sock, err) { clearTimeout(guard); fail(err as Error); },
        close() { clearTimeout(guard); if (!done) { done = true; resolve(out); } },
      },
    }).catch((e) => { clearTimeout(guard); fail(e as Error); });
  });
}

// Serialize all commands through a promise chain.
let chain: Promise<unknown> = Promise.resolve();

export function rcon(command: string): Promise<string> {
  const result = chain.then(() => runOnce(command), () => runOnce(command));
  chain = result.catch(() => {});
  return result;
}

/** Run several commands in order; returns each stripped response. Stops on error. */
export async function rconAll(commands: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const c of commands) out.push(stripColor(await rcon(c)));
  return out;
}
