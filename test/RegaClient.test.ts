import * as http from 'http';
import { AddressInfo } from 'net';
import { buildRenameScript, execRegaScript, renameCcuDevice } from '../src/hm/RegaClient';
import { initLogger } from '../src/utils/Logger';

initLogger({ level: 'error' });

describe('buildRenameScript', () => {
  test('targets the address, guards on default name, renames channels', () => {
    const s = buildRenameScript('SHELLY0006', 'Krauetergarten');
    expect(s).toContain('o.Address() == "SHELLY0006"');
    expect(s).toContain('o.Name().Contains("SHELLY0006")');
    expect(s).toContain('o.Name("Krauetergarten")');
    expect(s).toContain('oCh.Name("Krauetergarten" # ":" # oCh.Address().StrValueByIndex(":", 1))');
    expect(s).toContain('WriteLine(out);');
  });

  test('escapes quotes and backslashes in names', () => {
    const s = buildRenameScript('SHELLY0001', 'Say "hi" \\ there');
    expect(s).toContain('o.Name("Say \\"hi\\" \\\\ there")');
  });
});

describe('execRegaScript / renameCcuDevice', () => {
  function regaServer(reply: string): Promise<{ server: http.Server; url: string; bodies: string[] }> {
    return new Promise((resolve) => {
      const bodies: string[] = [];
      const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          bodies.push(body);
          // tclrega.exe replies with the script output followed by a status block
          res.end(`${reply}\r\n<xml><exec>/tclrega.exe</exec><sessionId></sessionId></xml>`);
        });
      });
      server.listen(0, '127.0.0.1', () => {
        const port = (server.address() as AddressInfo).port;
        resolve({ server, url: `http://127.0.0.1:${port}/tclrega.exe`, bodies });
      });
    });
  }

  test('strips the <xml><exec> trailer and returns the script output', async () => {
    const { server, url, bodies } = await regaServer('renamed');
    const result = await renameCcuDevice(url, 'SHELLY0006', 'Krauetergarten');
    server.close();
    expect(result).toBe('renamed');
    expect(bodies[0]).toContain('o.Name("Krauetergarten")');
  });

  test('resolves null on connection error instead of throwing', async () => {
    const result = await execRegaScript('http://127.0.0.1:1/tclrega.exe', 'WriteLine("x");');
    expect(result).toBeNull();
  });
});
