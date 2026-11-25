import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type {
  AgentConnectionState,
  AgentKind,
  ConnectAgentSelection,
  DesktopJob,
  DesktopNotification,
  DesktopState,
  JobState,
} from "../shared/contracts";
import type { HistoryCursor } from "./history/types";
import type { OutboxEntry } from "./telemetry/types";

export interface JobRecord {
  job: DesktopJob;
  payload: unknown;
}

export interface OutboxRecord {
  id: string;
  kind: string;
  payload: unknown;
  attempts: number;
  nextAttemptAt: string;
  createdAt: string;
}

export interface AgentConnectionRecord {
  selection: ConnectAgentSelection;
  state: AgentConnectionState;
  updatedAt: string;
}

interface JobRow {
  id: string;
  kind: DesktopJob["kind"];
  agent_kind: AgentKind | null;
  state: JobState;
  progress: number;
  message: string;
  payload: string;
  created_at: string;
  updated_at: string;
}

interface NotificationRow {
  id: string;
  job_id: string | null;
  severity: DesktopNotification["severity"];
  title: string;
  body: string;
  created_at: string;
  read_at: string | null;
  action_route: string | null;
}

interface OutboxRow {
  id: string;
  kind: string;
  payload: string;
  attempts: number;
  next_attempt_at: string;
  created_at: string;
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function toJob(row: JobRow): JobRecord {
  return {
    job: {
      id: row.id,
      kind: row.kind,
      agentKind: row.agent_kind ?? undefined,
      state: row.state,
      progress: row.progress,
      message: row.message,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    },
    payload: parseJson(row.payload),
  };
}

function toNotification(row: NotificationRow): DesktopNotification {
  return {
    id: row.id,
    jobId: row.job_id ?? undefined,
    severity: row.severity,
    title: row.title,
    body: row.body,
    createdAt: row.created_at,
    readAt: row.read_at ?? undefined,
    actionRoute: row.action_route ?? undefined,
  };
}

export class DesktopStore {
  private readonly database: DatabaseSync;

  constructor(path: string) {
    this.database = new DatabaseSync(path);
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS app_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK(kind IN ('connect', 'history-import', 'runtime')),
        agent_kind TEXT,
        state TEXT NOT NULL,
        progress REAL NOT NULL,
        message TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS jobs_queue ON jobs(state, created_at);
      CREATE TABLE IF NOT EXISTS notifications (
        id TEXT PRIMARY KEY,
        job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL,
        severity TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        created_at TEXT NOT NULL,
        read_at TEXT,
        action_route TEXT
      );
      CREATE INDEX IF NOT EXISTS notifications_created ON notifications(created_at DESC);
      CREATE TABLE IF NOT EXISTS outbox (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        payload TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_error TEXT
      );
      CREATE INDEX IF NOT EXISTS outbox_due ON outbox(next_attempt_at, created_at);
      CREATE TABLE IF NOT EXISTS telemetry_event_ids (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL
      );
      INSERT OR IGNORE INTO telemetry_event_ids(id, created_at)
        SELECT id, created_at FROM outbox WHERE kind = 'telemetry';
      CREATE TABLE IF NOT EXISTS agent_connections (
        kind TEXT PRIMARY KEY,
        selection TEXT NOT NULL,
        state TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS history_cursors (
        source_id TEXT PRIMARY KEY,
        cursor TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      PRAGMA user_version = 2;
    `);
  }

  initializeState(webUrl: string): void {
    const insert = this.database.prepare(
      "INSERT INTO app_state(key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING",
    );
    insert.run("version", "1");
    insert.run("firstRunComplete", "false");
    insert.run("runtime", "stopped");
    insert.run("webUrl", webUrl);
  }

  getDesktopState(): DesktopState {
    const rows = this.database
      .prepare("SELECT key, value FROM app_state")
      .all() as unknown as {
      key: string;
      value: string;
    }[];
    const values = new Map(rows.map((row) => [row.key, row.value]));
    const runtime = values.get("runtime");
    return {
      version: 1,
      firstRunComplete: values.get("firstRunComplete") === "true",
      runtime:
        runtime === "starting" || runtime === "ready" || runtime === "degraded"
          ? runtime
          : "stopped",
      webUrl: values.get("webUrl") ?? "",
      jobs: this.listJobs(),
    };
  }

  updateDesktopState(
    patch: Partial<
      Pick<DesktopState, "firstRunComplete" | "runtime" | "webUrl">
    >,
  ): DesktopState {
    const update = this.database.prepare(
      "UPDATE app_state SET value = ? WHERE key = ?",
    );
    if (patch.firstRunComplete !== undefined) {
      update.run(String(patch.firstRunComplete), "firstRunComplete");
    }
    if (patch.runtime !== undefined) update.run(patch.runtime, "runtime");
    if (patch.webUrl !== undefined) update.run(patch.webUrl, "webUrl");
    return this.getDesktopState();
  }

  saveAgentConnection(
    selection: ConnectAgentSelection,
    state: AgentConnectionState,
  ): void {
    const now = new Date().toISOString();
    this.database
      .prepare(
        `INSERT INTO agent_connections(kind, selection, state, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(kind) DO UPDATE SET
           selection = excluded.selection,
           state = excluded.state,
           updated_at = excluded.updated_at`,
      )
      .run(selection.kind, JSON.stringify(selection), state, now);
  }

  getAgentConnection(kind: AgentKind): AgentConnectionRecord | undefined {
    const row = this.database
      .prepare(
        "SELECT selection, state, updated_at FROM agent_connections WHERE kind = ?",
      )
      .get(kind) as
      | { selection: string; state: AgentConnectionState; updated_at: string }
      | undefined;
    if (!row) return undefined;
    const selection = parseJson(row.selection) as
      | ConnectAgentSelection
      | undefined;
    if (!selection) return undefined;
    return { selection, state: row.state, updatedAt: row.updated_at };
  }

  async getCursor(sourceId: string): Promise<HistoryCursor | undefined> {
    const row = this.database
      .prepare("SELECT cursor FROM history_cursors WHERE source_id = ?")
      .get(sourceId) as { cursor: string } | undefined;
    return row
      ? (parseJson(row.cursor) as HistoryCursor | undefined)
      : undefined;
  }

  async saveCursor(sourceId: string, cursor: HistoryCursor): Promise<void> {
    this.database
      .prepare(
        `INSERT INTO history_cursors(source_id, cursor, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(source_id) DO UPDATE SET cursor = excluded.cursor, updated_at = excluded.updated_at`,
      )
      .run(sourceId, JSON.stringify(cursor), new Date().toISOString());
  }

  createJob(input: {
    kind: DesktopJob["kind"];
    agentKind?: AgentKind;
    payload?: unknown;
    message?: string;
  }): DesktopJob {
    const now = new Date().toISOString();
    const id = randomUUID();
    this.database
      .prepare(
        `INSERT INTO jobs(id, kind, agent_kind, state, progress, message, payload, created_at, updated_at)
         VALUES (?, ?, ?, 'queued', 0, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.kind,
        input.agentKind ?? null,
        input.message ?? "Waiting to start",
        JSON.stringify(input.payload ?? null),
        now,
        now,
      );
    return this.getJob(id).job;
  }

  getJob(id: string): JobRecord {
    const row = this.database
      .prepare("SELECT * FROM jobs WHERE id = ?")
      .get(id) as unknown as JobRow | undefined;
    if (!row) throw new Error("Job not found");
    return toJob(row);
  }

  listJobs(): DesktopJob[] {
    const rows = this.database
      .prepare("SELECT * FROM jobs ORDER BY created_at DESC LIMIT 200")
      .all() as unknown as JobRow[];
    return rows.map((row) => toJob(row).job);
  }

  updateJob(
    id: string,
    patch: { state?: JobState; progress?: number; message?: string },
  ): DesktopJob {
    const current = this.getJob(id).job;
    this.database
      .prepare(
        "UPDATE jobs SET state = ?, progress = ?, message = ?, updated_at = ? WHERE id = ?",
      )
      .run(
        patch.state ?? current.state,
        Math.max(0, Math.min(1, patch.progress ?? current.progress)),
        patch.message ?? current.message,
        new Date().toISOString(),
        id,
      );
    return this.getJob(id).job;
  }

  recoverQueuedJobs(): DesktopJob[] {
    this.database.exec(
      "UPDATE jobs SET state = 'queued', message = 'Resuming after supervisor restart' WHERE state = 'running'",
    );
    return this.listJobs().filter((job) => job.state === "queued");
  }

  claimNextJob(kinds: readonly DesktopJob["kind"][]): JobRecord | undefined {
    if (kinds.length === 0) return undefined;
    const placeholders = kinds.map(() => "?").join(",");
    const row = this.database
      .prepare(
        `SELECT id FROM jobs WHERE state = 'queued' AND kind IN (${placeholders}) ORDER BY created_at LIMIT 1`,
      )
      .get(...kinds) as unknown as { id: string } | undefined;
    if (!row) return undefined;
    const changed = this.database
      .prepare(
        "UPDATE jobs SET state = 'running', updated_at = ? WHERE id = ? AND state = 'queued'",
      )
      .run(new Date().toISOString(), row.id);
    return changed.changes === 1 ? this.getJob(row.id) : undefined;
  }

  cancelJob(id: string): DesktopJob | undefined {
    this.database
      .prepare(
        "UPDATE jobs SET state = 'cancelled', message = 'Cancelled', updated_at = ? WHERE id = ? AND state IN ('queued', 'running')",
      )
      .run(new Date().toISOString(), id);
    return this.getJob(id).job;
  }

  createNotification(input: {
    jobId?: string;
    severity: DesktopNotification["severity"];
    title: string;
    body: string;
    actionRoute?: string;
  }): DesktopNotification {
    const id = randomUUID();
    this.database
      .prepare(
        `INSERT INTO notifications(id, job_id, severity, title, body, created_at, action_route)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.jobId ?? null,
        input.severity,
        input.title.slice(0, 200),
        input.body.slice(0, 2_000),
        new Date().toISOString(),
        input.actionRoute ?? null,
      );
    const row = this.database
      .prepare("SELECT * FROM notifications WHERE id = ?")
      .get(id) as unknown as NotificationRow;
    return toNotification(row);
  }

  listNotifications(): DesktopNotification[] {
    const rows = this.database
      .prepare("SELECT * FROM notifications ORDER BY created_at DESC LIMIT 500")
      .all() as unknown as NotificationRow[];
    return rows.map(toNotification);
  }

  markNotificationsRead(ids: readonly string[]): void {
    if (ids.length === 0) return;
    const statement = this.database.prepare(
      "UPDATE notifications SET read_at = ? WHERE id = ? AND read_at IS NULL",
    );
    const now = new Date().toISOString();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      for (const id of ids) statement.run(now, id);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  async putIfAbsent(entry: OutboxEntry): Promise<boolean> {
    if (entry.id !== entry.event.id) {
      throw new Error("Telemetry outbox ID must match its stable event ID");
    }
    const now = new Date().toISOString();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const registered = this.database
        .prepare(
          "INSERT INTO telemetry_event_ids(id, created_at) VALUES (?, ?) ON CONFLICT(id) DO NOTHING",
        )
        .run(entry.id, now);
      if (registered.changes === 0) {
        this.database.exec("COMMIT");
        return false;
      }
      this.database
        .prepare(
          `INSERT INTO outbox(id, kind, payload, attempts, next_attempt_at, created_at, updated_at)
           VALUES (?, 'telemetry', ?, 0, ?, ?, ?)`,
        )
        .run(entry.id, JSON.stringify(entry.event), now, now, now);
      this.database.exec("COMMIT");
      return true;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  enqueueOutbox(kind: string, payload: unknown): OutboxRecord {
    const now = new Date().toISOString();
    const id = randomUUID();
    this.database
      .prepare(
        `INSERT INTO outbox(id, kind, payload, next_attempt_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(id, kind, JSON.stringify(payload), now, now, now);
    return this.getOutbox(id);
  }

  private getOutbox(id: string): OutboxRecord {
    const row = this.database
      .prepare("SELECT * FROM outbox WHERE id = ?")
      .get(id) as unknown as OutboxRow;
    return {
      id: row.id,
      kind: row.kind,
      payload: parseJson(row.payload),
      attempts: row.attempts,
      nextAttemptAt: row.next_attempt_at,
      createdAt: row.created_at,
    };
  }

  dueOutbox(now = new Date().toISOString(), limit = 20): OutboxRecord[] {
    const rows = this.database
      .prepare(
        "SELECT * FROM outbox WHERE next_attempt_at <= ? ORDER BY created_at LIMIT ?",
      )
      .all(now, limit) as unknown as OutboxRow[];
    return rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      payload: parseJson(row.payload),
      attempts: row.attempts,
      nextAttemptAt: row.next_attempt_at,
      createdAt: row.created_at,
    }));
  }

  deleteOutbox(id: string): void {
    this.database.prepare("DELETE FROM outbox WHERE id = ?").run(id);
  }

  failOutbox(id: string, error: string, nextAttemptAt: string): OutboxRecord {
    this.database
      .prepare(
        "UPDATE outbox SET attempts = attempts + 1, last_error = ?, next_attempt_at = ?, updated_at = ? WHERE id = ?",
      )
      .run(error.slice(0, 1_000), nextAttemptAt, new Date().toISOString(), id);
    return this.getOutbox(id);
  }

  close(): void {
    this.database.close();
  }
}
