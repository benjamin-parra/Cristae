// Tipos del entry `cristae/grammar` (álgebra de composición de los elementos <cristae-*>:
// ENTIDADES que renderizan + MODIFICADORES que transforman lo que producen sus hijos).
// Segmento puro: no toca DOM más allá de la interfaz mínima de Element, ni importa
// engine/render/element. Mantener sincronizado con src/grammar/.

// ── Firmas (src/grammar/grammar.js) ─────────────────────────────────────────
/** `'fold'` = un apply sobre TODOS los targets; `'map'` = uno por target; `null` = hoja. */
export type GrammarCombine = "fold" | "map" | null;
export type GrammarArity = "leaf" | "wrapper";

export interface GrammarSignature {
  /** Kinds que el nodo transforma de sus hijos; `[]` (u omitido) ⇒ hoja. */
  consumes?: string[];
  /** Kinds que aporta hacia arriba (≥1). */
  produces: string[];
  combine?: GrammarCombine;
  arity: GrammarArity;
  /** Productores ligados (label/overlay): kind del host cuyo `suppressed` leen. */
  bindsTo?: string;
  /** El wrapper re-emite hacia arriba los hijos consumidos (default `true`). */
  passThrough?: boolean;
}

// ── Units (src/grammar/reduce.js) ───────────────────────────────────────────
/** Lo que un nodo aporta a su padre en el recorrido post-orden. */
export interface GrammarUnit {
  kind: string;
  id: string | number;
  /** Handle imperativo de la capa (set/move/patch). */
  handle: unknown;
  /** Source que lee la unit (point/bubble/label). */
  source?: unknown;
  /** Ref VIVA del set de supresión del host (getter), o `null` si no hay capa. */
  readonly suppressed: Set<unknown> | null;
}

/** Transformación que aporta un modificador; el intérprete hace el dispatch fold/map. */
export type GrammarApply = (
  engine: unknown,
  targets: GrammarUnit[],
  config: Record<string, unknown>,
) => GrammarUnit[] | null | undefined;

// ── Registro (src/grammar/grammar.js) ───────────────────────────────────────
/** Instancia de gramática: universo de kinds + registro de firmas. Los tags son
 *  case-insensitive. Los lectores devuelven `null` para un tag no registrado. */
export interface Grammar {
  readonly kinds: Set<string>;
  readonly mode: "throw" | "warn";
  register(
    tag: string,
    signature: GrammarSignature,
    opts?: { apply?: GrammarApply },
  ): void;
  signatureFor(tag: string): GrammarSignature | null;
  applyFor(tag: string): GrammarApply | null;
  isRegistered(tag: string): boolean;
  isWrapper(tag: string): boolean;
  isLeaf(tag: string): boolean;
}

export function defineGrammar(config: {
  kinds: string[];
  mode?: "throw" | "warn";
}): Grammar;

// ── Validación (src/grammar/validate.js) ────────────────────────────────────
/** R1 hoja con hijos · R2 wrapper sin hijo que produzca lo que consume · R3 wrapper
 *  sin hijos · R4 firma incoherente o kind fuera del universo. */
export type GrammarErrorCode = "R1" | "R2" | "R3" | "R4";

export class GrammarError extends Error {
  constructor(code: GrammarErrorCode, node: Element | null, message: string);
  readonly code: GrammarErrorCode;
  /** Nodo culpable, o `null` cuando el error es de la firma (R4). */
  readonly node: Element | null;
}

/** R4 + coherencia de la firma, al registrarla. Lanza `GrammarError`. */
export function validateSignature(
  tag: string,
  signature: GrammarSignature,
  kinds: Set<string>,
): void;

/** Juicio de tipos R1–R3 sobre el subárbol, ANTES de tocar el motor (un árbol inválido
 *  no crea estado). `mode: 'throw'` lanza; `'warn'` reporta y devuelve `false`. */
export function validate(
  root: Element,
  ctx: {
    signatureFor: (tag: string) => GrammarSignature | null;
    isRegistered: (tag: string) => boolean;
    mode: "throw" | "warn";
  },
): boolean;

// ── Reducción (src/grammar/reduce.js) ───────────────────────────────────────
/** Unit a partir de la capa montada. `suppressed` es un getter → siempre la ref viva. */
export function buildUnit(
  kind: string,
  handle: { id: string | number; source?: unknown; [k: string]: unknown },
  engine: unknown,
): GrammarUnit;

/** Units que aporta una HOJA ya montada; `[]` si todavía no tiene handle. */
export function leafUnits(
  el: Element,
  engine: unknown,
  ctx: { signatureFor: (tag: string) => GrammarSignature | null },
): GrammarUnit[];

/** Reduce un WRAPPER: monta sus hijos de gramática, junta sus units, separa
 *  targets/pass-through por `consumes` y aplica `combine`. */
export function reduceModifier(
  el: Element,
  engine: unknown,
  ctx: {
    signatureFor: (tag: string) => GrammarSignature | null;
    applyFor: (tag: string) => GrammarApply | null;
    isRegistered: (tag: string) => boolean;
  },
): GrammarUnit[];

// ── Montaje / utilidades (src/grammar/mounting.js, util.js) ─────────────────
/** Modificador más cercano hacia arriba que envuelve a `el` (excluyéndose), parando en
 *  <cristae-map>: quien lo envuelve es quien lo monta. `null` si no hay. */
export function enclosingModifier(
  el: Element,
  isWrapper: (tag: string) => boolean,
): Element | null;

/** Hijos que participan de la gramática: custom elements registrados, excluyendo los de
 *  configuración (`slot="bubble"`) y el DOM plano. */
export function grammarChildren(
  el: Element,
  isRegistered: (tag: string) => boolean,
): Element[];

/** Nombre legible de un elemento para mensajes de error. */
export function tagName(el: Element | null | undefined): string;
