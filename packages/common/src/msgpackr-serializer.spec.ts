import {describe, expect, it} from 'vitest';
import {MsgpackrSerializer} from './msgpackr-serializer';

// Test data for various scenarios
const testData = [
    {input: null, description: 'null value'},
    {input: undefined, description: 'undefined value'},
    {input: true, description: 'boolean true'},
    {input: false, description: 'boolean false'},
    {input: 42, description: 'integer'},
    {input: 3.14, description: 'floating-point number'},
    {input: 'Hello, world!', description: 'string'},
    {input: [1, 2, 3], description: 'array of numbers'},
    {input: {key: 'value'}, description: 'simple object'},
    {input: {nested: {key: 'value'}}, description: 'nested object'},
    {input: [true, null, {key: 42}], description: 'mixed array'},
    {input: Buffer.from('buffer data'), description: 'Buffer object'},
];

describe('MsgpackrSerializer', () => {
    const serializer = new MsgpackrSerializer();

    describe('round-trip', () => {
        testData.forEach(({input, description}) => {
            it(`should correctly encode and decode ${description}`, () => {
                const encoded = serializer.encode(input);
                const decoded = serializer.decode(encoded);
                expect(decoded).toEqual(input);
                expect(encoded).toBeInstanceOf(Uint8Array);
            });
        });
    });

    describe('edge cases', () => {
        it('should throw an error for invalid input to decode', () => {
            const invalidData = new Uint8Array([255, 255, 255]);
            expect(() => serializer.decode(invalidData)).toThrow();
        });

        it('should handle empty buffer during decode', () => {
            const emptyBuffer = new Uint8Array();
            expect(() => serializer.decode(emptyBuffer)).toThrow();
        });
    });
});
