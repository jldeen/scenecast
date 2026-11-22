// StuntDouble's replica format: manifest.json's JSON Schema, generated from the Rust types (`stuntdouble schema`).
import { readFileSync } from 'node:fs';

export const SCHEMA_VERSION = 'scenecast.bundle.v2';
export const schemaPath = new URL('./schema/bundle.v2.schema.json', import.meta.url);
export const schema = () => JSON.parse(readFileSync(schemaPath, 'utf8'));
