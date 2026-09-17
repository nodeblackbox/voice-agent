import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

const alias = {
  '@core': resolve('src/core'),
  '@shared': resolve('src/shared'),
  '@renderer': resolve('src/renderer/src')
}

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'node',
          environment: 'node',
          include: ['src/core/**/*.test.ts', 'src/main/**/*.test.ts', 'src/shared/**/*.test.ts']
        },
        resolve: { alias }
      },
      {
        test: {
          name: 'web',
          environment: 'jsdom',
          include: ['src/renderer/**/*.test.{ts,tsx}']
        },
        resolve: { alias }
      }
    ],
    coverage: {
      provider: 'v8',
      include: ['src/core/**', 'src/renderer/src/**', 'src/main/services/**'],
      exclude: ['**/*.test.*', 'src/renderer/src/main.tsx']
    }
  }
})
