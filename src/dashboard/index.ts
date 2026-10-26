/**
 * The embedding surface for the dashboard (`@piquette/engine/dashboard`): the
 * route table and the hosted D1 reader, for a host Worker that supplies its
 * own auth and its own tenant mapping. Node-free.
 */
export { createApp, type AppDeps } from "../ui/server/app.ts";
export { D1TraceReader, type D1Like, type D1ReaderOptions } from "../ui/server/trace_reader_d1.ts";
export { AmbiguousSession, type TraceReader } from "../ui/server/trace_reader.ts";
