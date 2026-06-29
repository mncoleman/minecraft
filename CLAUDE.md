# CLAUDE.md — minecraft

Private, browser-based Minecraft (Eaglercraft) server + web panel, live at
**minecraft.mncoleman.com**. The panel (`auth/`, a Bun + Hono service) handles
login, worlds, friends, and feedback; the game runs in a separate hardened
container. See `README.md` for the full architecture and `deploy/DEPLOY.md` for
the deploy/rollback runbook.

## Panel feedback → GitHub issues

The **Feedback** tab (`auth/src/feedback.ts`) lets any logged-in player send
general feedback, a feature request, or a bug report. Each submission:

1. is recorded in the `feedback` table,
2. DMs the owner on Telegram, and
3. **auto-creates a GitHub issue in this repo** labelled `panel-feedback` plus a
   kind label (`feedback` / `enhancement` / `bug`).

Players can see the status of everything they've sent under **Feedback → "Your
recent submissions"**, which reads each issue's live state + labels (cached ~60s)
and shows a status badge.

### ⚠️ Resolution labeling convention (ALWAYS follow this)

**When you close a `panel-feedback` issue, you MUST add exactly one resolution
label** so the submitter sees an accurate status in the panel:

| Add this label on close | Panel shows | Use when |
| --- | --- | --- |
| `complete` | **Completed** (green) | The request was done / shipped / fixed. |
| `could-not-fulfil` | **Couldn't do this** (muted) | It won't or can't be done. |

A `panel-feedback` issue closed **without** one of these labels shows a neutral
**"Closed"** in the panel — that's the signal you forgot to label it. Don't
leave panel-feedback issues closed-but-unlabeled.

While an item is being actively worked on, you may add an `in-progress` label to
an **open** issue; the panel then shows **In progress** instead of **Open**.

The panel matches these labels case-insensitively and also accepts common
synonyms, so the exact spelling is forgiving:

- **Completed:** `complete`, `completed`, `done`, `addressed`, `fixed`,
  `shipped`, `resolved`
- **Couldn't do this:** `could-not-fulfil`, `could-not-fulfill`, `cannot-fulfil`,
  `cant-do`, `wontfix`, `wont-fix`, `not-planned`, `declined` (closing the issue
  with GitHub's native "not planned" reason also maps here)
- **In progress:** `in-progress`, `wip`, `working-on-it`

The canonical two to use are **`complete`** and **`could-not-fulfil`** — they
exist as repo labels. The mapping lives in `statusFor()` in
`auth/src/feedback.ts`; keep this table and that function in sync.
