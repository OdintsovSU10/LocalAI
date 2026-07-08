import { execFile } from "node:child_process";

function psString(value) {
  return String(value || "").replaceAll("'", "''");
}

export function chooseFolderWithExplorer({ title = "Select folder", initialPath = "" } = {}) {
  const script = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$owner = New-Object System.Windows.Forms.Form
$owner.Text = 'Locus'
$owner.TopMost = $true
$owner.ShowInTaskbar = $true
$owner.StartPosition = 'CenterScreen'
$owner.Size = New-Object System.Drawing.Size(1, 1)
$owner.Opacity = 0.01

$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = '${psString(title)}'
$dialog.ShowNewFolderButton = $true
try { $dialog.AutoUpgradeEnabled = $true } catch {}
try { $dialog.UseDescriptionForTitle = $true } catch {}

if ('${psString(initialPath)}' -and (Test-Path -LiteralPath '${psString(initialPath)}' -PathType Container)) {
  $dialog.SelectedPath = '${psString(initialPath)}'
}

try {
  $owner.Show()
  $owner.Activate()
  $result = $dialog.ShowDialog($owner)
  if ($result -eq [System.Windows.Forms.DialogResult]::OK) {
    [Console]::Out.Write($dialog.SelectedPath)
    exit 0
  }
  exit 2
}
finally {
  $dialog.Dispose()
  $owner.Close()
  $owner.Dispose()
}
`;

  return new Promise((resolve, reject) => {
    const encoded = Buffer.from(script, "utf16le").toString("base64");
    execFile(
      "powershell.exe",
      ["-NoProfile", "-STA", "-EncodedCommand", encoded],
      { windowsHide: false, timeout: 600000 },
      (error, stdout, stderr) => {
        if (error?.code === 2) {
          resolve(null);
          return;
        }
        if (error) {
          reject(new Error(stderr?.trim() || error.message));
          return;
        }
        resolve(stdout.trim() || null);
      }
    );
  });
}
