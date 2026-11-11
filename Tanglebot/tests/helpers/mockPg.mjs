// A stand-in for a pg Pool. Every query is recorded; respond(sql, params) may return a result.
export function mockPg(respond = () => undefined) {
  const calls = [];
  const run = async (sql, params) => {
    calls.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params });
    const result = await respond(String(sql), params);
    return { rows: [], rowCount: 0, ...result };
  };
  const client = { query: run, release: () => { client.released = true; } };
  const pool = { query: run, connect: async () => client, on() {}, end: async () => {} };
  const find = pattern => calls.filter(c => pattern.test(c.sql));
  return { pool, client, calls, find };
}
