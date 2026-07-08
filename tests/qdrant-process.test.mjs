import test from "node:test";
import assert from "node:assert/strict";
import { defaultManagedQdrantBaseUrl, managedQdrantSettings } from "../apps/rag-api/src/qdrant-process.js";

test("managedQdrantSettings uses local Qdrant defaults when settings are empty", () => {
  const settings = managedQdrantSettings({});

  assert.equal(settings.baseUrl, defaultManagedQdrantBaseUrl);
  assert.equal(settings.port, 6333);
  assert.equal(settings.local, true);
});

test("managedQdrantSettings normalizes configured Qdrant paths to service root", () => {
  const settings = managedQdrantSettings({
    qdrant: {
      url: "http://127.0.0.1:6333/collections/localai_chunks"
    }
  });

  assert.equal(settings.baseUrl, "http://127.0.0.1:6333");
  assert.equal(settings.port, 6333);
  assert.equal(settings.local, true);
});

test("managedQdrantSettings marks remote Qdrant as unmanaged", () => {
  const settings = managedQdrantSettings({
    qdrant: {
      url: "https://qdrant.example.test:6333"
    }
  });

  assert.equal(settings.local, false);
  assert.equal(settings.manageable, false);
});

test("managedQdrantSettings marks non-default local ports as unmanaged", () => {
  const settings = managedQdrantSettings({
    qdrant: {
      url: "http://127.0.0.1:7333"
    }
  });

  assert.equal(settings.local, true);
  assert.equal(settings.port, 7333);
  assert.equal(settings.manageable, false);
});
