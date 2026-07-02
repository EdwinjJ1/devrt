import { Readable, Writable } from "node:stream";
type CliIO = {
    cwd?: string;
    stdin?: Readable;
    stdout?: Writable;
    stderr?: Writable;
    env?: NodeJS.ProcessEnv;
};
export declare function runCli(args: string[], io?: CliIO): Promise<number>;
export {};
