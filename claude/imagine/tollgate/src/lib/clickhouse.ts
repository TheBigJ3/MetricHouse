/** Stub. Tollgate does not run; this exists so the schema reads honestly. */
export const ch = {
  async insert(table: string, rows: unknown[]): Promise<void> {},
  async query(sql: string, params?: Record<string, unknown>): Promise<any> {},
}
