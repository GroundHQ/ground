import {
    applyUpdateV2,
    encodeStateAsUpdateV2,
    Array as YArray,
    Doc as YDoc,
    Map as YMap,
    Text as YText,
} from 'yjs';
import {z} from 'zod';
import {
    type Codec,
    decodeMsgpack,
    encodeMsgpack,
    MsgpackCodec,
} from '../codec.js';
import {AppError} from '../errors.js';
import {decodeHex, encodeHex} from '../hex.js';
import {getNow, type Timestamp} from '../timestamp.js';
import {
    assert,
    assertNever,
    type Brand,
    type Nothing,
    type Unsubscribe,
    zip,
} from '../utils.js';
import {Uuid} from '../uuid.js';
import {observe, type OpLog} from './observe.js';

export interface CrdtDiff<T> {
    readonly timestamp: Timestamp;
    readonly payload: CrdtDiffPayload<T>;
}

export type CrdtDiffPayload<T> = Brand<Uint8Array, [T, 'crdt_diff_buffer']>;

export type CrdtDiffString<T> = Brand<string, [T, 'crdt_diff_string']>;

export function zCrdtDiffString<T>() {
    return z.string() as unknown as z.ZodType<CrdtDiffString<T>>;
}

export function stringifyCrdtDiff<T>(diff: CrdtDiff<T>): CrdtDiffString<T> {
    return decodeHex(encodeMsgpack(diff)) as CrdtDiffString<T>;
}

export function parseCrdtDiff<T>(diff: CrdtDiffString<T>): CrdtDiff<T> {
    return decodeMsgpack(encodeHex(diff)) as CrdtDiff<T>;
}

export function toCrdtDiff<T>(
    diff: CrdtDiff<T> | CrdtDiffString<T>
): CrdtDiff<T> {
    if (typeof diff === 'string') {
        return parseCrdtDiff(diff);
    } else {
        return diff;
    }
}

const ROOT_KEY = 'root';
const ROOT_VALUE = 'value';

export interface DiffOptions {
    readonly origin?: any;
}

export class Crdt<T> {
    static from<T>(value: T): Crdt<T> {
        const doc = new YDoc();
        const rootMap = doc.getMap<YValue>(ROOT_KEY);
        rootMap.set(ROOT_VALUE, mapToYValue(value));

        return new Crdt(doc);
    }

    static load<T>(diff: CrdtDiff<T> | CrdtDiffString<T>): Crdt<T> {
        const doc = new YDoc();
        applyUpdateV2(doc, toCrdtDiff(diff).payload);

        return new Crdt(doc);
    }

    private constructor(private doc: YDoc) {}

    private get root(): YMap<YValue> {
        return this.doc.getMap(ROOT_KEY);
    }

    private get yValue(): YValue {
        return this.root.get(ROOT_VALUE);
    }

    private set yValue(value: YValue) {
        this.root.set(ROOT_VALUE, value);
    }

    snapshot(): T {
        return mapFromYValue(this.yValue) as T;
    }

    state(): CrdtDiff<T> {
        return {
            timestamp: getNow(),
            payload: encodeStateAsUpdateV2(this.doc) as CrdtDiffPayload<T>,
        };
    }

    clone(): Crdt<T> {
        return Crdt.load(this.state());
    }

    map<TResult>(mapper: (snapshot: T) => TResult): TResult {
        // for simplicity sake we make full copy of the Doc to create a snapshot,
        // even though not all fields might be needed by the mapper
        return mapper(this.snapshot());
    }

    // if recipe returns T, then whole doc is overridden with the returned value
    update(
        recipe: (draft: T) => T | void,
        options?: DiffOptions
    ): CrdtDiff<T> | undefined {
        const snapshot = this.snapshot();
        const locator = new Locator();
        locator.addDeep(snapshot, this.yValue);

        const [replacement, log] = observe(snapshot, draft => recipe(draft));
        // diff can be undefined if no change were made in recipe
        let diff: CrdtDiff<T> | undefined = undefined;
        const unsub = this.subscribe('update', (nextDiff: CrdtDiff<T>) => {
            diff = nextDiff;
        });
        this.doc.transact(() => {
            if (replacement) {
                this.yValue = mapToYValue(replacement);
            } else {
                replayLog(log, locator);
            }
        }, options?.origin);
        unsub();

        // todo: add tests for returned diff
        return diff;
    }

    apply(diff: CrdtDiff<T> | CrdtDiffString<T>, options?: DiffOptions): void {
        applyUpdateV2(this.doc, toCrdtDiff(diff).payload, options?.origin);
    }

    subscribe(
        event: 'update',
        next: (diff: CrdtDiff<T>, options: DiffOptions) => Nothing
    ): Unsubscribe {
        const fn = (state: Uint8Array, origin: string | undefined) =>
            next(
                {
                    timestamp: getNow(),
                    payload: state as CrdtDiffPayload<T>,
                },
                {origin: origin ?? undefined}
            );
        this.doc.on('updateV2', fn);

        return () => {
            this.doc.off('updateV2', fn);
        };
    }
}

type YValue =
    | YMap<YValue>
    | YArray<YValue>
    | YText
    | number
    | boolean
    | string
    | null
    | undefined;

const INTERPRET_AS_KEY = '__interpret_as__';

function mapFromYValue(yValue: YValue): unknown {
    if (
        yValue === null ||
        yValue === undefined ||
        typeof yValue === 'string' ||
        typeof yValue === 'number' ||
        typeof yValue === 'boolean'
    ) {
        return yValue;
    } else if (yValue.constructor === YArray) {
        return [
            ...(yValue as YArray<any>).map(item =>
                mapFromYValue(item.get('value'))
            ),
        ];
    } else if (yValue.constructor === YMap) {
        if ((yValue as YMap<any>).get(INTERPRET_AS_KEY) === 'obj') {
            const result: any = {};
            for (const [key, value] of (yValue as YMap<any>).entries()) {
                if (key === INTERPRET_AS_KEY) continue;
                result[key] = mapFromYValue(value);
            }

            return result;
        } else {
            return new Map(
                [...(yValue as YMap<any>).entries()].map(([key, value]) => [
                    key,
                    mapFromYValue(value),
                ])
            );
        }
    } else {
        throw new AppError('cannot map unsupported YValue: ' + yValue);
    }
}

// mapToYValue assumes that value is valid for the given schema
function mapToYValue(value: any): YValue {
    if (
        value === null ||
        value === undefined ||
        typeof value === 'string' ||
        typeof value === 'number' ||
        typeof value === 'boolean'
    ) {
        return value;
    } else if (value.constructor === Map) {
        const entries = [...value.entries()].map(
            ([key, value]) => [key, mapToYValue(value)] as const
        );
        return new YMap(entries);
    } else if (value.constructor === Array) {
        const result = new YArray<YValue>();
        result.push(
            value.map(x => new YMap<YValue>([['value', mapToYValue(x)]]))
        );

        return result;
    } else if (value.constructor === Object) {
        const result = new YMap<YValue>();
        result.set(INTERPRET_AS_KEY, 'obj');
        for (const [key, fieldValue] of Object.entries(value)) {
            result.set(key, mapToYValue(fieldValue));
        }

        return result;
    } else if (value.constructor === Uuid) {
        const result = new YMap<YValue>();
        result.set(INTERPRET_AS_KEY, 'uuid');
        result.set('value', value.toString());
        return result;
    } else {
        throw new AppError('cannot map unsupported value to YValue: ' + value);
    }
}

class Locator {
    private map = new Map<any, YValue>();

    constructor() {}

    locate(subject: any): YValue {
        const result = this.map.get(subject);

        if (!result) {
            throw new AppError('could not locate subject ' + subject);
        }

        return result;
    }

    addDeep(subject: any, yValue: YValue) {
        if (
            subject === null ||
            subject === undefined ||
            typeof subject === 'string' ||
            typeof subject === 'number' ||
            typeof subject === 'boolean' ||
            subject.constructor === Uuid
        ) {
            return subject;
        } else if (subject.constructor === Map) {
            this.map.set(subject, yValue);

            for (const [key, subjectValue] of subject.entries()) {
                const yValueValue = (yValue as YMap<YValue>).get(key);

                this.addDeep(subjectValue, yValueValue);
            }
        } else if (subject.constructor === Array) {
            this.map.set(subject, yValue);
            for (let i = 0; i < subject.length; i += 1) {
                const subjectItem: unknown = subject[i];
                const yValueItem = (yValue as YArray<YMap<YValue>>)
                    .get(i)
                    .get('value');

                this.addDeep(subjectItem, yValueItem);
            }
        } else if (subject.constructor === Object) {
            this.map.set(subject, yValue);

            for (const [key, subjectValue] of Object.entries(subject)) {
                const yValueValue = (yValue as YMap<YValue>).get(key);
                this.addDeep(subjectValue, yValueValue);
            }
        } else {
            throw new AppError(
                'cannot add unsupported subject to Locator: ' + subject
            );
        }
    }
}

function replayLog(log: OpLog, locator: Locator): void {
    for (const entry of log) {
        const yValue = locator.locate(entry.subject);

        if (entry.type === 'array_push') {
            assert(yValue instanceof YArray, 'array_push: expected YArray');

            const yArgs = entry.args.map(
                x => new YMap<YValue>([['value', mapToYValue(x)]])
            );
            yValue.push(yArgs);

            zip(entry.args, yArgs).forEach(([arg, yArg]) =>
                locator.addDeep(arg, yArg)
            );
        } else if (entry.type === 'array_unshift') {
            assert(yValue instanceof YArray, 'array_unshift: expected YArray');

            const yArgs = entry.args.map(
                x => new YMap<YValue>([['value', mapToYValue(x)]])
            );
            yValue.unshift(yArgs);

            zip(entry.args, yArgs).forEach(([arg, yArg]) =>
                locator.addDeep(arg, yArg)
            );
        } else if (entry.type === 'array_set') {
            assert(yValue instanceof YArray, 'array_set: expected YArray');

            (yValue.get(entry.index) as YMap<YValue>).set(
                'value',
                mapToYValue(entry.value)
            );
            locator.addDeep(entry.value, yValue.get(entry.index));
        } else if (entry.type === 'map_clear') {
            assert(yValue instanceof YMap, 'map_clear: expected YMap');
            yValue.clear();
        } else if (entry.type === 'map_delete') {
            assert(yValue instanceof YMap, 'map_delete: expected YMap');
            yValue.delete(entry.args[0]);
        } else if (entry.type === 'map_set') {
            assert(yValue instanceof YMap, 'map_set: expected YMap');
            const yMapValue = mapToYValue(entry.args[1]);
            yValue.set(entry.args[0], yMapValue);
            locator.addDeep(entry.args[1], yMapValue);
        } else if (entry.type === 'object_delete') {
            assert(yValue instanceof YMap, 'object_delete: expected YMap');
            yValue.delete(entry.prop);
        } else if (entry.type === 'object_set') {
            assert(yValue instanceof YMap, 'object_set: expected YMap');
            const yMapValue = mapToYValue(entry.value);
            yValue.set(entry.prop, yMapValue);
            locator.addDeep(entry.value, yMapValue);
        } else {
            assertNever(entry);
        }
    }
}

export class CrdtCodec<T> implements Codec<Crdt<T>> {
    private readonly msgpackCoder = new MsgpackCodec();

    encode(data: Crdt<T>): Uint8Array {
        return this.msgpackCoder.encode(data.state());
    }

    decode(buf: Uint8Array): Crdt<T> {
        return Crdt.load(this.msgpackCoder.decode(buf));
    }
}
