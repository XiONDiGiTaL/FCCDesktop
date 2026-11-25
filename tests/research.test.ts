import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ResearchService,
  extractSearchResults,
  isPrivateAddress,
  isPublicHttpUrl,
  stripHtml,
} from '../electron/research/service'

const dirs: string[] = []
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

test('stripHtml removes scripts, styles and markup but keeps text', () => {
  const html =
    '<html><head><title>Ignore</title><style>.x{}</style></head><body><h1>Free models</h1><p>Use the <b>free</b> tier &amp; cite sources.</p><script>alert(1)</script></body></html>'
  const text = stripHtml(html)
  assert.match(text, /Free models/)
  assert.match(text, /Use the free tier & cite sources\./)
  assert.doesNotMatch(text, /alert|\.x\{/)
})

test('search results decode DuckDuckGo redirects and snippets', () => {
  const html = `
    <div class="result results_links results_links_deep web-result ">
      <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdocs&amp;rut=abc">Example <b>Docs</b></a>
      <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdocs">A free <b>tier</b> with limits.</a>
    </div>
    <div class="result results_links">
      <a class="result__a" href="https://second.example/page">Second result</a>
      <a class="result__snippet">Another snippet.</a>
    </div>`
  const results = extractSearchResults(html, 5)
  assert.equal(results.length, 2)
  assert.equal(results[0].url, 'https://example.com/docs')
  assert.equal(results[0].title, 'Example Docs')
  assert.equal(results[0].snippet, 'A free tier with limits.')
  assert.equal(results[1].url, 'https://second.example/page')
})

test('URL checks block loopback, private ranges and non-http schemes', () => {
  assert.equal(isPublicHttpUrl('https://example.com/docs'), true)
  assert.equal(isPublicHttpUrl('http://127.0.0.1/admin'), false)
  assert.equal(isPublicHttpUrl('http://localhost:8082'), false)
  assert.equal(isPublicHttpUrl('http://10.0.0.4/'), false)
  assert.equal(isPublicHttpUrl('http://192.168.1.5/'), false)
  assert.equal(isPublicHttpUrl('http://169.254.169.254/latest/meta-data'), false)
  assert.equal(isPublicHttpUrl('file:///C:/Windows/win.ini'), false)
  assert.equal(isPublicHttpUrl('https://user:pass@example.com/'), false)
  assert.equal(isPublicHttpUrl('https://example.com:8443/'), false)
  assert.equal(isPublicHttpUrl('https://[::1]/'), false)
  assert.equal(isPrivateAddress('8.8.8.8'), false)
  assert.equal(isPrivateAddress('fd00::1'), true)
})

test('MCP server authenticates, initializes and lists research tools', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fcc-research-'))
  dirs.push(dir)
  const service = new ResearchService(dir)
  assert.equal(await service.start(), true)
  const configPath = service.configPath()
  assert.ok(configPath)
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as {
    mcpServers: { fcc_research: { url: string; headers: Record<string, string> } }
  }
  const { url, headers } = config.mcpServers.fcc_research
  assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/)

  const call = async (body: unknown, token: string | null = headers.Authorization) =>
    fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: token } : {}),
      },
      body: JSON.stringify(body),
    })

  const unauthorized = await call({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, null)
  assert.equal(unauthorized.status, 401)

  const init = await call({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
  })
  const initBody = (await init.json()) as { result: { serverInfo: { name: string } } }
  assert.equal(initBody.result.serverInfo.name, 'fcc_research')

  const list = await call({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
  const listBody = (await list.json()) as { result: { tools: Array<{ name: string }> } }
  assert.deepEqual(
    listBody.result.tools.map((tool) => tool.name).sort(),
    ['fetch_url', 'github_repo', 'web_search'],
  )

  const blocked = await call({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'fetch_url', arguments: { url: 'http://127.0.0.1:8082/' } },
  })
  const blockedBody = (await blocked.json()) as {
    result: { isError: boolean; content: Array<{ text: string }> }
  }
  assert.equal(blockedBody.result.isError, true)
  assert.match(blockedBody.result.content[0].text, /public|private|allowed/i)

  service.stop()
})
