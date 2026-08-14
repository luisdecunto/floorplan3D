import { validateFloorplanDocument, type FloorplanDocumentV2 } from "./floorplan-document.ts";

const DATABASE_NAME = "planform-v2";
const STORE_NAME = "projects";

function openDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, 1);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) database.createObjectStore(STORE_NAME, { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function saveProjectLocally(document: FloorplanDocumentV2) {
  if (typeof indexedDB === "undefined") return;
  const database = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).put(document);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
  database.close();
}

export async function loadLatestProjectLocally() {
  if (typeof indexedDB === "undefined") return null;
  const database = await openDatabase();
  const projects = await new Promise<FloorplanDocumentV2[]>((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, "readonly");
    const request = transaction.objectStore(STORE_NAME).getAll();
    request.onsuccess = () => resolve(request.result as FloorplanDocumentV2[]);
    request.onerror = () => reject(request.error);
  });
  database.close();
  return projects
    .map((project) => validateFloorplanDocument(project))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] ?? null;
}

export function serializeProject(document: FloorplanDocumentV2) {
  return JSON.stringify(document, null, 2);
}

export function parseProject(contents: string) {
  return validateFloorplanDocument(JSON.parse(contents));
}

export function downloadProject(document: FloorplanDocumentV2) {
  const blob = new Blob([serializeProject(document)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = window.document.createElement("a");
  anchor.href = url;
  anchor.download = `${document.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase() || "floorplan"}.planform.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}
