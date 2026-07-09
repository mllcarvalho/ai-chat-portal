import * as path from 'node:path';

/**
 * Onde procurar o PowerShell no Windows, do mais confiável para o menos.
 *
 * Os caminhos ABSOLUTOS vêm primeiro e NÃO são filtrados por existsSync: o host
 * da extensão aberto pela GUI herda um PATH mínimo — às vezes sem o System32 —
 * e aí o nome nu `powershell` falha com ENOENT; um existsSync que falhe por
 * permissão/EDR descartaria o caminho absoluto que teria funcionado. Deixar o
 * próprio spawn decidir custa um erro barato e cobre os dois casos.
 *
 * SysNative existe para processos 32-bit num Windows 64-bit (o redirecionamento
 * WOW64 faz System32 apontar para SysWOW64); SysWOW64 cobre o caso inverso.
 * `pwsh` (PowerShell 7) é o último: raramente está instalado numa máquina
 * corporativa, e era justamente o erro dele que aparecia para o usuário.
 */
export function powerShellCandidates(): string[] {
  const sysRoot = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  const ps = (dir: string) => path.join(sysRoot, dir, 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return [ps('System32'), ps('SysNative'), ps('SysWOW64'), 'powershell', 'pwsh'];
}

/**
 * Diretório de trabalho seguro para processos filhos. NÃO use o homedir: em
 * máquina corporativa ele costuma ser uma pasta redirecionada para rede e, com
 * o share fora do ar, o spawn falha com ENOENT — parece "executável não
 * encontrado", mas é o cwd. System32 e `/` estão sempre lá.
 */
export function spawnCwd(): string {
  return process.platform === 'win32'
    ? process.env.SystemRoot || process.env.windir || 'C:\\Windows'
    : '/';
}
