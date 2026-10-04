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
 * The `elements` item schema for browser_snapshot and browser_open.
 *
 * Written as a literal rather than generated, because `defineTool` validates the output schema
 * against its own `ValueSchemaSpec` and a generated `Record<string, …>` is too wide to satisfy
 * it. The field table above remains the single source of truth: `tests/element-fields.test.mjs`
 * asserts that these properties and `projectElement`'s output are exactly the table's keys, so
 * the two cannot drift even though one is typed by hand.
 */
export declare const ELEMENT_ITEM_SCHEMA: {
    readonly type: "object";
    readonly additionalProperties: false;
    readonly properties: {
        readonly ref: {
            readonly type: "number";
            readonly required: true;
        };
        readonly kind: {
            readonly type: "string";
            readonly required: true;
        };
        readonly label: {
            readonly type: "string";
            readonly required: true;
        };
        readonly selector: {
            readonly type: "string";
        };
        readonly x: {
            readonly type: "number";
            readonly required: true;
        };
        readonly y: {
            readonly type: "number";
            readonly required: true;
        };
        readonly frame: {
            readonly type: "boolean";
        };
    };
};
/**
 * The `nodes` item schema for browser_a11y.
 *
 * Same reasoning as {@link ELEMENT_ITEM_SCHEMA}: literal for the type checker, table-backed by
 * test.
 */
export declare const NODE_ITEM_SCHEMA: {
    readonly type: "object";
    readonly additionalProperties: false;
    readonly properties: {
        readonly ref: {
            readonly type: "number";
            readonly required: true;
        };
        readonly role: {
            readonly type: "string";
            readonly required: true;
        };
        readonly name: {
            readonly type: "string";
            readonly required: true;
        };
        readonly value: {
            readonly type: "string";
        };
        readonly states: {
            readonly type: "array";
            readonly required: true;
            readonly items: {
                readonly type: "string";
            };
        };
        readonly depth: {
            readonly type: "number";
            readonly required: true;
        };
        readonly tag: {
            readonly type: "string";
            readonly required: true;
        };
        readonly selector: {
            readonly type: "string";
            readonly required: true;
        };
        readonly x: {
            readonly type: "number";
            readonly required: true;
        };
        readonly y: {
            readonly type: "number";
            readonly required: true;
        };
        readonly frame: {
            readonly type: "boolean";
        };
    };
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
export declare function projectElement<T extends object>(element: T): T;
/**
 * Project one accessibility node into the shape the schema declares.
 * @param node - the node as the provider produced it.
 * @returns exactly the declared fields.
 */
export declare function projectNode<T extends object>(node: T): T;
/** The field names each table declares, for tests that check the two stay in step. */
export declare const DECLARED_FIELDS: {
    readonly element: string[];
    readonly node: string[];
};
