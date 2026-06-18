// ============================================================================
//  Weapons Pack  —  for the legacy EaglerForge client (EaglerForge v1.3.2)
//
//  No custom-item framework on this client, so weapons are VANILLA ITEMS you
//  hold. Hold one of the items below and RIGHT-CLICK A BLOCK to fire an
//  explosion at the spot you're aiming at.
//
//     Held item        Weapon            Blast
//     -----------       --------------    -----------------------
//     Blaze Rod         RPG Launcher      big, flaming   (str 8)
//     Stick             Boomstick (gun)   small          (str 3)
//     Gunpowder         Grenade           medium         (str 5)
//     Fire Charge       NUKE              huge, flaming  (str 30)
//     Nether Star       Airstrike         carpet-bomb line of blasts
//
//  Notes:
//   - Aim at a block (not the open sky) and stand back — the blast hurts you.
//   - Explosions are created client-side; in singleplayer the integrated
//     server may restore some broken blocks. Entity damage / knockback / fire
//     all apply. (A fully server-authoritative version isn't possible on this
//     client build — it has no server-code injection API.)
//   - Self-defers until the game API is ready, so it's safe to autoload.
// ============================================================================

(function WeaponsPack() {
  "use strict";

  // item registry name -> blast config
  var WEAPONS = {
    "blaze_rod":   { name: "RPG Launcher", strength: 8,  fire: true  },
    "stick":       { name: "Boomstick",    strength: 3,  fire: false },
    "gunpowder":   { name: "Grenade",      strength: 5,  fire: false },
    "fire_charge": { name: "NUKE",         strength: 30, fire: true  },
    "nether_star": { name: "Airstrike",    strength: 4,  fire: true, airstrike: true }
  };

  var REFS = {};          // item id -> underlying Item ref (resolved when ready)
  var lastFire = 0;       // debounce timestamp

  function resolveRefs() {
    Object.keys(WEAPONS).forEach(function (id) {
      try {
        var wrap = ModAPI.items[id];
        REFS[id] = (wrap && wrap.getRef) ? wrap.getRef() : null;
      } catch (e) { REFS[id] = null; }
    });
  }

  // Which configured weapon is the player currently holding? (null if none)
  function heldWeapon() {
    try {
      var inv = ModAPI.mcinstance.$thePlayer.$inventory;
      var arr = (inv.$mainInventory && inv.$mainInventory.data) ? inv.$mainInventory.data : inv.$mainInventory;
      var stack = arr[inv.$currentItem];
      if (!stack) return null;
      var item = stack.$item || (stack.$getItem && stack.$getItem());
      if (!item) return null;
      var ids = Object.keys(REFS);
      for (var i = 0; i < ids.length; i++) {
        if (REFS[ids[i]] && REFS[ids[i]] === item) return ids[i];
      }
      return null;
    } catch (e) { return null; }
  }

  function fire(cfg) {
    var mc = ModAPI.mcinstance, w = mc.$theWorld, p = mc.$thePlayer, mo = mc.$objectMouseOver;
    var x, y, z;
    if (mo && mo.$blockPos) {
      x = mo.$blockPos.$x + 0.5; y = mo.$blockPos.$y + 1; z = mo.$blockPos.$z + 0.5;
    } else {
      x = p.$posX; y = p.$posY + 1; z = p.$posZ;   // fallback: at the player
    }
    if (cfg.airstrike) {
      for (var i = -3; i <= 3; i++) {
        w.$newExplosion(null, x + i * 4, y, z, cfg.strength, true, true);
      }
    } else {
      w.$newExplosion(null, x, y, z, cfg.strength, !!cfg.fire, true);
    }
  }

  function onRightClick(e) {
    try {
      var id = heldWeapon();
      if (!id) return;                       // not holding a weapon -> normal behavior
      var now = Date.now();
      if (now - lastFire < 250) return;      // debounce rapid packets
      lastFire = now;
      fire(WEAPONS[id]);
      if (e) { e.preventDefault = true; }    // best-effort: suppress the vanilla use
      if (ModAPI.displayToChat) ModAPI.displayToChat("§7[Weapons] §ffired §e" + WEAPONS[id].name);
    } catch (err) {
      console.error("[Weapons] fire error:", err);
    }
  }

  function setup() {
    try {
      resolveRefs();
      var resolved = Object.keys(REFS).filter(function (k) { return !!REFS[k]; });
      ModAPI.addEventListener("sendpacketplayerblockplacement", onRightClick);
      console.log("[Weapons] loaded. Hold & right-click a block. Recognised items: " + resolved.join(", "));
      if (ModAPI.displayToChat) {
        ModAPI.displayToChat("§a[Weapons] ready — hold blaze rod / stick / gunpowder / fire charge / nether star and right-click.");
      }
    } catch (err) {
      console.error("[Weapons] setup error:", err);
    }
  }

  // Wait until the runtime + the right-click event type are available, then arm.
  function waitReady() {
    try {
      if (window.ModAPI && ModAPI.addEventListener && ModAPI.events &&
          ModAPI.events.types && ModAPI.events.types.indexOf("sendpacketplayerblockplacement") !== -1 &&
          ModAPI.items && ModAPI.mcinstance) {
        setup();
        return;
      }
    } catch (e) { /* keep waiting */ }
    setTimeout(waitReady, 500);
  }

  waitReady();
})();
