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

/**
 * Snapshot JSON-shaped data properties once, without invoking accessors.
 * A proxy can run traps during reflection; any reflection error is denied.
 */
function parseActions(input: unknown): readonly Action[] | null {
  try {
    if (!Array.isArray(input)) return null;
    const lengthDescriptor = Object.getOwnPropertyDescriptor(input, 'length');
    if (!lengthDescriptor || !('value' in lengthDescriptor)) return null;
    const length: unknown = lengthDescriptor.value;
    if (typeof length !== 'number' || !Number.isInteger(length) || length < 1 || length > 20) return null;
    const arrayKeys = Reflect.ownKeys(input);
    if (arrayKeys.length !== length + 1 || !arrayKeys.includes('length')) return null;

    const actions: Action[] = [];
    for (let i = 0; i < length; i++) {
      // Inspect array elements as own data properties, not through an iterator/getter.
      if (!arrayKeys.includes(String(i))) return null;
      const element = Object.getOwnPropertyDescriptor(input, String(i));
      if (!element || !('value' in element) || element.enumerable !== true) return null;
      const value: unknown = element.value;
      if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) return null;
      const keys = Reflect.ownKeys(value);
      if (keys.length !== 2 || !keys.includes('kind')) return null;
      const kindProperty = Object.getOwnPropertyDescriptor(value, 'kind');
      if (!kindProperty || !('value' in kindProperty) || kindProperty.enumerable !== true) return null;
      const kind: unknown = kindProperty.value;
      const field = kind === 'notes.read' ? 'id' : kind === 'notes.create' ? 'text' : null;
      if (field === null || !keys.includes(field)) return null;
      const payloadProperty = Object.getOwnPropertyDescriptor(value, field);
      if (!payloadProperty || !('value' in payloadProperty) || payloadProperty.enumerable !== true) return null;
      const payload: unknown = payloadProperty.value;
      if (kind === 'notes.read' && validIdentifier(payload)) {
        actions.push(Object.freeze({ kind: 'notes.read', id: payload }));
      } else if (kind === 'notes.create' && typeof payload === 'string' &&
                 payload.trim().length > 0 && payload.length <= 4096) {
        actions.push(Object.freeze({ kind: 'notes.create', text: payload }));
      } else {
        return null;
      }
    }
    return Object.freeze(actions);
  } catch {
    // Revoked proxies and throwing reflection traps are invalid, not unhandled failures.
    return null;
  }
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
