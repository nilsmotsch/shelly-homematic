import * as http from 'http';
import { getLogger } from '../utils/Logger';

// Minimal ReGa script client (the thkl/HVI "RegaRequest" pattern): device and
// channel NAMES live only in ReGa's DOM — they are not part of the XML-RPC
// interface protocol — so the only way to label our SHELLYnnnn devices with
// the Shelly's own name is to POST a ReGa script to tclrega.exe (port 8181).
export function execRegaScript(url: string, script: string): Promise<string | null> {
  return new Promise((resolve) => {
    // ReGa is ISO-8859-1, not UTF-8 (umlauts in names would be mangled).
    const body = Buffer.from(script, 'latin1');
    const urlObj = new URL(url);
    const req = http.request(
      {
        host: urlObj.hostname,
        port: parseInt(urlObj.port || '8181'),
        path: urlObj.pathname || '/tclrega.exe',
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': body.length },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const data = Buffer.concat(chunks).toString('latin1');
          // Response is the script output followed by an <xml><exec>… status block
          const pos = data.lastIndexOf('<xml><exec>');
          resolve(pos === -1 ? data : data.substring(0, pos));
        });
      }
    );
    req.setTimeout(10000, () => req.destroy(new Error('rega timeout')));
    req.on('error', (err) => {
      getLogger().debug(`ReGa script failed: ${err}`);
      resolve(null);
    });
    req.end(body);
  });
}

function regaQuote(s: string): string {
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

// Renames the ReGa device with the given address (and its channels, CCU
// auto-rename style: "name:N") to the Shelly's name. Deliberately idempotent
// and non-destructive:
// - only renames while the current name still CONTAINS the SHELLYnnnn address
//   (the ReGa default is "TYPE ADDRESS") — a user rename is never overwritten;
// - skips if another object already owns the target name ("conflict").
// Outputs one of: renamed | kept | conflict | notfound.
export function buildRenameScript(hmAddress: string, name: string): string {
  const qAddr = regaQuote(hmAddress);
  const qName = regaQuote(name);
  return (
    'string out = "notfound";' +
    'string sDevId;' +
    'foreach(sDevId, dom.GetObject(ID_DEVICES).EnumUsedIDs()) {' +
    '  object o = dom.GetObject(sDevId);' +
    `  if (o && (o.Address() == ${qAddr})) {` +
    `    if (o.Name().Contains(${qAddr})) {` +
    `      object ex = dom.GetObject(${qName});` +
    '      if (ex && (ex.ID() != o.ID())) { out = "conflict"; }' +
    '      else {' +
    `        o.Name(${qName});` +
    '        string sChId;' +
    '        foreach(sChId, o.Channels().EnumIDs()) {' +
    '          object oCh = dom.GetObject(sChId);' +
    `          if (oCh && oCh.Name().Contains(${qAddr})) {` +
    `            oCh.Name(${qName} # ":" # oCh.Address().StrValueByIndex(":", 1));` +
    '          }' +
    '        }' +
    '        out = "renamed";' +
    '      }' +
    '    } else { out = "kept"; }' +
    '  }' +
    '}' +
    'WriteLine(out);'
  );
}

export async function renameCcuDevice(regaUrl: string, hmAddress: string, name: string): Promise<string | null> {
  const result = await execRegaScript(regaUrl, buildRenameScript(hmAddress, name));
  return result === null ? null : result.trim();
}
