// The published bin bundles its dependencies, so their license texts ship
// with it. Regenerated on every build from the installed versions.
import { readFileSync, writeFileSync } from 'node:fs'

const BUNDLED = ['@modelcontextprotocol/server', '@modelcontextprotocol/core', 'zod']
const root = new URL('../', import.meta.url)

const sections = BUNDLED.map((name) => {
  const dir = new URL(`node_modules/${name}/`, root)
  const pkg = JSON.parse(readFileSync(new URL('package.json', dir), 'utf8'))
  const license = readFileSync(new URL('LICENSE', dir), 'utf8').trim()
  return `## ${name} ${pkg.version}\n\nLicense: ${pkg.license}\n\n\`\`\`\n${license}\n\`\`\``
})

writeFileSync(
  new URL('THIRD-PARTY-NOTICES.md', root),
  `# Third-party notices\n\n\`dist/cli.js\` bundles the packages below. Their licenses apply to those portions of the file.\n\n${sections.join('\n\n')}\n`,
)
console.log(`THIRD-PARTY-NOTICES.md: ${BUNDLED.length} packages`)
