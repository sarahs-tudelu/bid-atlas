export interface DocumentMetadataIndexDatabase {
  prepare(sql: string): {
    run(): Promise<unknown> | unknown;
  };
}

const triggerInitialization = new WeakMap<object, Promise<void>>();

const DOCUMENT_METADATA_TRIGGER_SQL = [
  `CREATE TRIGGER IF NOT EXISTS documents_metadata_fts_insert
   AFTER INSERT ON documents BEGIN
     INSERT INTO document_metadata_fts (
       document_id, project_id, name, document_type, description, discipline,
       sheet_numbers, keywords, search_text, source_url
     ) VALUES (
       new.id, new.project_id, new.name, new.document_type, new.description,
       coalesce(new.discipline, ''), coalesce(new.sheet_numbers, '[]'),
       coalesce(new.keywords, '[]'), new.search_text, new.source_url
     );
   END`,
  `CREATE TRIGGER IF NOT EXISTS documents_metadata_fts_update
   AFTER UPDATE OF
     project_id, name, document_type, description, discipline, sheet_numbers,
     keywords, search_text, source_url ON documents BEGIN
     DELETE FROM document_metadata_fts WHERE document_id = old.id;
     INSERT INTO document_metadata_fts (
       document_id, project_id, name, document_type, description, discipline,
       sheet_numbers, keywords, search_text, source_url
     ) VALUES (
       new.id, new.project_id, new.name, new.document_type, new.description,
       coalesce(new.discipline, ''), coalesce(new.sheet_numbers, '[]'),
       coalesce(new.keywords, '[]'), new.search_text, new.source_url
     );
   END`,
  `CREATE TRIGGER IF NOT EXISTS documents_metadata_fts_delete
   AFTER DELETE ON documents BEGIN
     DELETE FROM document_metadata_fts WHERE document_id = old.id;
   END`,
] as const;

/**
 * Sites applies migrations one statement at a time. SQLite trigger bodies contain
 * internal semicolons, so install the idempotent triggers through one prepared
 * statement per trigger after the trigger-free FTS schema migration has run.
 */
export async function ensureDocumentMetadataIndex(
  db: DocumentMetadataIndexDatabase,
): Promise<void> {
  const key = db as object;
  const existing = triggerInitialization.get(key);
  if (existing) {
    return existing;
  }

  const initialization = (async () => {
    for (const sql of DOCUMENT_METADATA_TRIGGER_SQL) {
      await db.prepare(sql).run();
    }
  })();
  triggerInitialization.set(key, initialization);

  try {
    await initialization;
  } catch (error) {
    triggerInitialization.delete(key);
    throw error;
  }
}
