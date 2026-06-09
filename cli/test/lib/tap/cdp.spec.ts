import { afterEach, describe, expect, it } from 'vitest'
import http from 'http'
import type { AddressInfo } from 'net'
import { WebSocketServer } from 'ws'
import type WebSocket from 'ws'

import {
  CdpConnectionError,
  CdpProtocolError,
  CdpSession,
  listTargets,
} from '../../../lib/tap/cdp'

const HOST = '127.0.0.1'

type Closer = () => Promise<void>

// Servers registered here are torn down after every test.
let closers: Closer[] = []

const listenHttp = (handler: http.RequestListener): Promise<{ server: http.Server, port: number }> => {
  return new Promise((resolve) => {
    const server = http.createServer(handler)

    server.listen(0, HOST, () => {
      closers.push(() => {
        return new Promise((done) => server.close(() => done()))
      })

      resolve({ server, port: (server.address() as AddressInfo).port })
    })
  })
}

const listenWs = (onConnection: (socket: WebSocket) => void): Promise<{ wss: WebSocketServer, port: number }> => {
  return new Promise((resolve) => {
    const wss = new WebSocketServer({ host: HOST, port: 0 }, () => {
      closers.push(() => {
        for (const client of wss.clients) {
          client.terminate()
        }

        return new Promise((done) => wss.close(() => done()))
      })

      resolve({ wss, port: (wss.address() as AddressInfo).port })
    })

    wss.on('connection', onConnection)
  })
}

/** A listening port with nothing behind it — connections are refused. */
const getClosedPort = async (): Promise<number> => {
  const { server, port } = await listenHttp(() => {})

  await new Promise((done) => server.close(() => done(null)))

  return port
}

afterEach(async () => {
  await Promise.all(closers.map((close) => close()))
  closers = []
})

describe('lib/tap/cdp', () => {
  describe('.listTargets', () => {
    it('resolves the parsed target list', async () => {
      const targets = [{ id: 'T1', type: 'page', url: 'http://localhost:5555/__/' }]

      const { port } = await listenHttp((req, res) => {
        expect(req.url).toBe('/json/list')
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify(targets))
      })

      expect(await listTargets(HOST, port)).toEqual(targets)
    })

    it('rejects with CdpConnectionError on a non-200 response', async () => {
      const { port } = await listenHttp((req, res) => {
        res.statusCode = 500
        res.end('boom')
      })

      await expect(listTargets(HOST, port)).rejects.toBeInstanceOf(CdpConnectionError)
    })

    it('rejects with CdpConnectionError on an unparseable response', async () => {
      const { port } = await listenHttp((req, res) => {
        res.end('{ not json')
      })

      await expect(listTargets(HOST, port)).rejects.toBeInstanceOf(CdpConnectionError)
    })

    it('rejects with CdpConnectionError when the endpoint is unreachable', async () => {
      const port = await getClosedPort()

      await expect(listTargets(HOST, port)).rejects.toBeInstanceOf(CdpConnectionError)
    })
  })

  describe('CdpSession.connect', () => {
    it('resolves a session against a live endpoint', async () => {
      const { port } = await listenWs(() => {})

      const session = await CdpSession.connect(`ws://${HOST}:${port}/devtools/page/T1`)

      session.close()
    })

    it('rejects with CdpConnectionError when the endpoint is unreachable', async () => {
      const port = await getClosedPort()

      await expect(CdpSession.connect(`ws://${HOST}:${port}/devtools/page/T1`)).rejects.toBeInstanceOf(CdpConnectionError)
    })

    it('rejects with CdpConnectionError when the upgrade never completes', async () => {
      // An http server with no upgrade handling accepts the TCP connection but
      // never finishes the websocket handshake.
      const { port } = await listenHttp(() => {})

      await expect(CdpSession.connect(`ws://${HOST}:${port}/devtools/page/T1`, { connectTimeout: 100 }))
      .rejects.toBeInstanceOf(CdpConnectionError)
    })
  })

  describe('CdpSession#send', () => {
    const connectTo = async (onMessage: (socket: WebSocket, message: any) => void): Promise<CdpSession> => {
      const { port } = await listenWs((socket) => {
        socket.on('message', (raw) => onMessage(socket, JSON.parse(String(raw))))
      })

      return CdpSession.connect(`ws://${HOST}:${port}/devtools/page/T1`)
    }

    it('resolves the result of a reply', async () => {
      const session = await connectTo((socket, message) => {
        expect(message.method).toBe('Runtime.evaluate')
        expect(message.params).toEqual({ expression: '1 + 1' })
        socket.send(JSON.stringify({ id: message.id, result: { result: { type: 'number', value: 2 } } }))
      })

      const result = await session.send('Runtime.evaluate', { expression: '1 + 1' })

      expect(result).toEqual({ result: { type: 'number', value: 2 } })
      session.close()
    })

    it('rejects with CdpProtocolError on an error reply', async () => {
      const session = await connectTo((socket, message) => {
        socket.send(JSON.stringify({ id: message.id, error: { code: -32000, message: 'Could not find object with given id' } }))
      })

      const err = await session.send('Runtime.callFunctionOn').catch((e) => e)

      expect(err).toBeInstanceOf(CdpProtocolError)
      expect(err.message).toBe('Could not find object with given id')
      expect(err.code).toBe(-32000)
      session.close()
    })

    it('ignores event frames and unparseable frames while waiting for a reply', async () => {
      const session = await connectTo((socket, message) => {
        socket.send(JSON.stringify({ method: 'Target.targetInfoChanged', params: {} }))
        socket.send('certainly not json')
        socket.send(JSON.stringify({ id: message.id, result: { ok: true } }))
      })

      expect(await session.send('Runtime.evaluate')).toEqual({ ok: true })
      session.close()
    })

    it('rejects in-flight calls when the socket closes mid-call', async () => {
      const session = await connectTo((socket) => {
        socket.terminate()
      })

      // No reply will ever come; the close must reject this promptly rather
      // than waiting out the call timeout.
      await expect(session.send('Runtime.evaluate')).rejects.toBeInstanceOf(CdpConnectionError)
    })

    it('rejects when a reply never arrives within the call timeout', async () => {
      const session = await connectTo(() => {})

      const err = await session.send('Runtime.evaluate', {}, { timeout: 100 }).catch((e) => e)

      expect(err).toBeInstanceOf(CdpConnectionError)
      expect(err.message).toContain('timed out')
      session.close()
    })

    it('rejects sends after the session is closed', async () => {
      const session = await connectTo(() => {})

      session.close()

      await expect(session.send('Runtime.evaluate')).rejects.toBeInstanceOf(CdpConnectionError)
    })

    it('close() is idempotent', async () => {
      const session = await connectTo(() => {})

      session.close()
      session.close()
    })
  })
})
