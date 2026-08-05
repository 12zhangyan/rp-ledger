import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const electronDir = path.dirname(fileURLToPath(import.meta.url))
