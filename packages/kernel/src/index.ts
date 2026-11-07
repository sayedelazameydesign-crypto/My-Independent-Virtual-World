/** A local-only prototype: these controls are not a sandbox or authentication layer. */
export type Capability = 'notes.read' | 'notes.create';
export type Action =
  | Readonly<{ kind: 'notes.read'; id: string }>
  | Readonly<{ kind: 'notes.create'; text: string }>;
export type Note = Readonly<{ id: string; text: string }>;
export type RunStatus = 'completed' | 'denied' | 'failed';
export type Observation = Readonly<{
  action: Capability;
  status: 'completed' | 'denied' | 'failed';
  note?: Note;
}>;
export type RunResult = Readonly<{
  status: RunStatus;
  phases: readonly ('understand' | 'plan' | 'act' | 'observe' | 'reflect')[];
  observations: readonly Observation[];
  reflection: string;
}>;
export type AuditEvent = Readonly<{
  agentId: string;
  action: Capability;
  status: Observation['status'];
}>;

/** A trusted host-provided store; implementors must reject on failure. */
export interface NoteStore {
  create(text: string): Promise<Note>;
  read(id: string): Promise<Note | undefined>;
}

/** Volatile default, intentionally not durable. */
export class MemoryNoteStore implements NoteStore {
  readonly #notes = new Map<string, Note>();
  #nextId = 1;
  async create(text: string): Promise<Note> {
    const note = Object.freeze({ id: String(this.#nextId++), text });
    this.#notes.set(note.id, note);
    return note;
  }
  async read(id: string): Promise<Note | undefined> {
    return this.#notes.get(id);
  }
}

/** Configuration and identity must be supplied by the trusted host, not an agent. */
export type KernelOptions = Readonly<{
  permissions: Readonly<Record<string, readonly Capability[]>>;
  store?: NoteStore;
  approveCreate?: (request: Readonly<{ agentId: string; action: Readonly<{ kind: 'notes.create'; text: string }> }>) => boolean | Promise<boolean>;
}>;

const validIdentifier = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 128;

/** Reject unknown actions and fields; copy before authorization to avoid later mutation. */
function parseActions(input: unknown): readonly Action[] | null {
  if (!Array.isArray(input) || input.length === 0 || input.length > 20) return null;
  const actions: Action[] = [];
  for (const value of input) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const entry = value as Record<string, unknown>;
    if (entry.kind === 'notes.read' && Object.keys(entry).length === 2 && validIdentifier(entry.id)) {
      actions.push(Object.freeze({ kind: 'notes.read', id: entry.id }));
    } else if (entry.kind === 'notes.create' && Object.keys(entry).length === 2 &&
      typeof entry.text === 'string' && entry.text.trim().length > 0 && entry.text.length <= 4096) {
      actions.push(Object.freeze({ kind: 'notes.create', text: entry.text }));
    } else {
      return null;
    }
  }
  return Object.freeze(actions);
}

export class Kernel {
  readonly #permissions = new Map<string, ReadonlySet<Capability>>();
  readonly #approveCreate: KernelOptions['approveCreate'];
  readonly #store: NoteStore;
  readonly #events: AuditEvent[] = [];

  constructor(options: KernelOptions) {
    for (const [agentId, capabilities] of Object.entries(options.permissions)) {
      if (!validIdentifier(agentId) || !Array.isArray(capabilities) ||
          capabilities.some((value) => value !== 'notes.read' && value !== 'notes.create')) {
        throw new Error('Invalid permission configuration');
      }
      this.#permissions.set(agentId, new Set(capabilities));
    }
    this.#approveCreate = options.approveCreate;
    this.#store = options.store ?? new MemoryNoteStore();
  }

  /**
   * Executes an explicit, bounded plan. This is deterministic orchestration, not an LLM.
   * A caller must authenticate the agent externally before using its ID.
   */
  async run(agentId: string, input: unknown): Promise<RunResult> {
    const phases: RunResult['phases'][number][] = ['understand', 'plan'];
    const actions = parseActions(input);
    if (!validIdentifier(agentId) || !actions || !this.#permissions.has(agentId)) {
      phases.push('reflect');
      return { status: 'denied', phases, observations: [], reflection: 'Invalid plan or unknown agent.' };
    }
    const observations: Observation[] = [];
    phases.push('act');
    for (const action of actions) {
      let observation: Observation;
      if (!this.#permissions.get(agentId)?.has(action.kind)) {
        observation = { action: action.kind, status: 'denied' };
      } else if (action.kind === 'notes.create') {
        try {
          // Fail closed; only an explicit true from the trusted host permits creation.
          const approved = this.#approveCreate && await this.#approveCreate(Object.freeze({ agentId, action }));
          if (approved !== true) {
            observation = { action: action.kind, status: 'denied' };
          } else {
            const stored = await this.#store.create(action.text);
            const note = Object.freeze({ id: stored.id, text: stored.text });
            observation = { action: action.kind, status: 'completed', note };
          }
        } catch {
          observation = { action: action.kind, status: 'failed' };
        }
      } else {
        try {
          const stored = await this.#store.read(action.id);
          observation = stored
            ? { action: action.kind, status: 'completed', note: Object.freeze({ id: stored.id, text: stored.text }) }
            : { action: action.kind, status: 'failed' };
        } catch {
          observation = { action: action.kind, status: 'failed' };
        }
      }
      observations.push(Object.freeze(observation));
      this.#events.push(Object.freeze({ agentId, action: action.kind, status: observation.status }));
      if (observation.status !== 'completed') break;
    }
    phases.push('observe', 'reflect');
    const status = observations.at(-1)?.status ?? 'failed';
    return {
      status,
      phases: Object.freeze(phases),
      observations: Object.freeze(observations),
      reflection: status === 'completed' ? 'Plan completed.' : 'Plan stopped before remaining actions.',
    };
  }

  /** A minimal in-memory audit, with no note content or provider credentials. */
  audit(): readonly AuditEvent[] {
    return Object.freeze([...this.#events]);
  }
}
