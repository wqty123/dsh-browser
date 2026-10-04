/**
 * The element and node field sets, declared once.
 *
 * WHY THIS FILE EXISTS
 *
 * The same field set used to be written out in four places: the page script produced an
 * object, `types.ts` declared its shape, a tool's `execute` rebuilt it as an explicit list,
 * and the tool's `output.schema` declared the properties. Nothing connected them, and the
 * result is this project's most repeatable bug:
 *
 *   - `browser_a11y`'s `selector` — computed by the provider, declared by the schema,
 *     printed by the renderer, and dropped by the projection. 134 tests stayed green.
 *   - `browser_screenshot`'s `width`/`height` — measured by the provider, declared by the
 *     schema, and dropped by the projection. 172 tests stayed green. It was found a round
 *     later, by reading the three places that agree and noticing the fourth did not.
 *
 * A hand-written allow-list is invisible to the type checker (it is an object literal) and to
 * the tests (nothing ran a tool). The fix is not a careful list; it is one list. Both the
 * schema fragment and the projection are derived from the tables below, so a field cannot be
 * present in one and absent from the other.
 *
 * The schema is the dangerous half: `additionalProperties: false` means a field the schema
 * does NOT declare causes the ENTIRE result to be rejected at run time, while a field the
 * projection forgets is silently dropped. One table cannot get either wrong on its own.
 */
/**
 * The fields of one entry in `browser_snapshot` / `browser_open`'s `elements`.
 *
 * `selector` is the reason this file exists; see the header. It was added to the schema and
 * the projection separately, and only one of them landed.
 */
const ELEMENT_FIELDS = {
    ref: { schema: { type: 'number' }, required: true },
    kind: { schema: { type: 'string' }, required: true },
    label: { schema: { type: 'string' }, required: true },
    selector: { schema: { type: 'string' } },
    x: { schema: { type: 'number' }, required: true },
    y: { schema: { type: 'number' }, required: true },
    frame: { schema: { type: 'boolean' } },
};
/**
 * The fields of one entry in `browser_a11y`'s `nodes`.
 *
 * Different shape from an element on purpose: a role and an accessible name carry meaning a
 * tag and a label string do not, and `depth` is what renders the tree.
 */
const NODE_FIELDS = {
    ref: { schema: { type: 'number' }, required: true },
    role: { schema: { type: 'string' }, required: true },
    name: { schema: { type: 'string' }, required: true },
    value: { schema: { type: 'string' } },
    states: { schema: { type: 'array', items: { type: 'string' } }, required: true },
    depth: { schema: { type: 'number' }, required: true },
    tag: { schema: { type: 'string' }, required: true },
    // Always present: the provider derives it for every node and yields an empty string when the
    // element has neither an id nor a name. Declaring it optional described a shape the provider
    // never produced, and the type said required — the same disagreement, one level down.
    selector: { schema: { type: 'string' }, required: true },
    x: { schema: { type: 'number' }, required: true },
    y: { schema: { type: 'number' }, required: true },
    frame: { schema: { type: 'boolean' } },
};
/**
 * Copy the declared fields out of a source value.
 *
 * Reads the table rather than naming fields, so anything the provider produces that the table
 * declares is carried through, and anything the table does not declare is left out — which is
 * what keeps the result and the schema in agreement in both directions.
 * @param fields - the field table to project through.
 * @param source - the value the provider produced.
 * @returns a new object holding exactly the declared fields that are present.
 */
function project(fields, source) {
    const out = {};
    for (const name of Object.keys(fields)) {
        const value = source[name];
        if (value !== undefined && value !== null)
            out[name] = value;
    }
    return out;
}
/**
 * The `elements` item schema for browser_snapshot and browser_open.
 *
 * Written as a literal rather than generated, because `defineTool` validates the output schema
 * against its own `ValueSchemaSpec` and a generated `Record<string, …>` is too wide to satisfy
 * it. The field table above remains the single source of truth: `tests/element-fields.test.mjs`
 * asserts that these properties and `projectElement`'s output are exactly the table's keys, so
 * the two cannot drift even though one is typed by hand.
 */
export const ELEMENT_ITEM_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    properties: {
        ref: { type: 'number', required: true },
        kind: { type: 'string', required: true },
        label: { type: 'string', required: true },
        selector: { type: 'string' },
        x: { type: 'number', required: true },
        y: { type: 'number', required: true },
        frame: { type: 'boolean' },
    },
};
/**
 * The `nodes` item schema for browser_a11y.
 *
 * Same reasoning as {@link ELEMENT_ITEM_SCHEMA}: literal for the type checker, table-backed by
 * test.
 */
export const NODE_ITEM_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    properties: {
        ref: { type: 'number', required: true },
        role: { type: 'string', required: true },
        name: { type: 'string', required: true },
        value: { type: 'string' },
        states: { type: 'array', required: true, items: { type: 'string' } },
        depth: { type: 'number', required: true },
        tag: { type: 'string', required: true },
        selector: { type: 'string', required: true },
        x: { type: 'number', required: true },
        y: { type: 'number', required: true },
        frame: { type: 'boolean' },
    },
};
/**
 * Project one snapshot element into the shape the schema declares.
 *
 * Generic in the source type so the caller keeps the precise shape `defineTool` inferred from
 * the schema: the projection decides which fields survive at run time, and the field table is
 * what guarantees that set matches the schema. Widening the return type here would only move
 * the mismatch to the call site.
 * @param element - the element as the provider produced it.
 * @returns exactly the declared fields.
 */
export function projectElement(element) {
    return project(ELEMENT_FIELDS, element);
}
/**
 * Project one accessibility node into the shape the schema declares.
 * @param node - the node as the provider produced it.
 * @returns exactly the declared fields.
 */
export function projectNode(node) {
    return project(NODE_FIELDS, node);
}
/** The field names each table declares, for tests that check the two stay in step. */
export const DECLARED_FIELDS = {
    element: Object.keys(ELEMENT_FIELDS),
    node: Object.keys(NODE_FIELDS),
};
