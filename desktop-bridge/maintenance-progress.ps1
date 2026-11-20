<# A passive, independent progress indicator. Closing it never cancels maintenance. #>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateNotNullOrEmpty()]
  [string]$StatePath,

  [Parameter(Mandatory = $true)]
  [ValidatePattern('^(install|uninstall)-[A-Za-z0-9]+$')]
  [string]$JobId,

  [ValidateSet('zh', 'en')]
  [string]$Locale = 'zh'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding

function Stop-Progress([string]$Code) {
  Write-Output (@{ ok = $false; code = $Code } | ConvertTo-Json -Compress)
  exit 1
}

function Read-ProgressState {
  try {
    $value = [IO.File]::ReadAllText($script:verifiedStatePath) | ConvertFrom-Json
    if ($null -eq $value -or -not [StringComparer]::Ordinal.Equals([string]$value.id, $JobId) -or
      @('armed', 'closing', 'installing', 'restarting', 'verifying', 'completed', 'complete', 'failed', 'cancelled') -cnotcontains [string]$value.phase -or
      @('install', 'uninstall') -cnotcontains [string]$value.action) { return $null }
    return $value
  } catch { return $null }
}

try {
  if ($env:DSH_BROWSER_TEST -eq '1' -or $null -ne $env:NODE_TEST_CONTEXT) { Stop-Progress 'TEST_CONTEXT_REFUSED' }
  if ($StatePath -notmatch '^(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+[\\/])') { Stop-Progress 'INVALID_STATE_PATH' }
  $script:verifiedStatePath = [IO.Path]::GetFullPath($StatePath)
  if ([IO.Path]::GetFileName($script:verifiedStatePath) -ine 'state.json' -or
    -not [StringComparer]::Ordinal.Equals([IO.Path]::GetFileName([IO.Path]::GetDirectoryName($script:verifiedStatePath)), $JobId) -or
    -not [IO.File]::Exists($script:verifiedStatePath)) { Stop-Progress 'INVALID_STATE_PATH' }
  $script:lastState = Read-ProgressState
  if ($null -eq $script:lastState) { Stop-Progress 'INVALID_JOB_STATE' }

  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing
  Add-Type -ReferencedAssemblies System.Windows.Forms, System.Drawing -TypeDefinition @'
using System;
using System.Drawing;
using System.Windows.Forms;
using Microsoft.Win32;
namespace DshBridgeMaintenance {
  public sealed class ProgressWindow : Form {
    private readonly Label heading;
    private readonly Label detail;
    private readonly Label elapsed;
    private readonly ProgressBar progress;
    private readonly bool dark;
    public ProgressWindow(string title) {
      try { dark = Convert.ToInt32(Registry.GetValue(@"HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize", "AppsUseLightTheme", 1)) == 0; }
      catch { dark = false; }
      Text = title;
      ShowInTaskbar = false;
      TopMost = false;
      MaximizeBox = false;
      MinimizeBox = false;
      FormBorderStyle = FormBorderStyle.FixedToolWindow;
      StartPosition = FormStartPosition.Manual;
      AutoScaleMode = AutoScaleMode.Dpi;
      ClientSize = new Size(380, 150);
      Font = new Font("Segoe UI", 9F, FontStyle.Regular);
      BackColor = dark ? Color.FromArgb(32, 32, 35) : Color.FromArgb(250, 250, 252);
      ForeColor = dark ? Color.FromArgb(240, 240, 244) : Color.FromArgb(36, 36, 40);
      heading = new Label { Location = new Point(18, 17), Size = new Size(344, 25), Font = new Font("Segoe UI", 11F, FontStyle.Bold), AutoEllipsis = true };
      detail = new Label { Location = new Point(18, 48), Size = new Size(344, 34), ForeColor = dark ? Color.FromArgb(184, 184, 194) : Color.FromArgb(100, 100, 110), AutoEllipsis = true };
      elapsed = new Label { Location = new Point(18, 91), Size = new Size(344, 20), ForeColor = detail.ForeColor };
      progress = new ProgressBar { Location = new Point(18, 121), Size = new Size(344, 5), Style = ProgressBarStyle.Marquee, MarqueeAnimationSpeed = 35 };
      Controls.Add(heading);
      Controls.Add(detail);
      Controls.Add(elapsed);
      Controls.Add(progress);
      Rectangle area = Screen.PrimaryScreen.WorkingArea;
      Location = new Point(Math.Max(area.Left, area.Right - Width - 20), Math.Max(area.Top, area.Bottom - Height - 20));
    }
    protected override bool ShowWithoutActivation { get { return true; } }
    protected override CreateParams CreateParams {
      get {
        CreateParams parameters = base.CreateParams;
        parameters.ExStyle |= 0x08000000 | 0x00000080; // WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW
        return parameters;
      }
    }
    public void UpdateStage(string title, string message, string time, bool running, bool failed) {
      heading.Text = title;
      detail.Text = message;
      elapsed.Text = time;
      heading.ForeColor = failed ? (dark ? Color.FromArgb(255, 150, 150) : Color.FromArgb(182, 51, 51)) : ForeColor;
      progress.Visible = running;
    }
  }
}
'@
  [Windows.Forms.Application]::EnableVisualStyles()
  # Escaped source stays valid with Windows PowerShell's ANSI script decoding.
  $copy = if ($Locale -eq 'zh') {
    '{"window":"DSH - \u6d4f\u89c8\u5668\u6865\u63a5","armed":"\u6b63\u5728\u51c6\u5907","closing":"\u6b63\u5728\u9000\u51fa DSH","installing":"\u6b63\u5728\u5b89\u88c5\u6d4f\u89c8\u5668\u6865\u63a5","uninstalling":"\u6b63\u5728\u5378\u8f7d\u6d4f\u89c8\u5668\u6865\u63a5","restarting":"\u6b63\u5728\u542f\u52a8 DSH","verifying":"\u6b63\u5728\u68c0\u67e5\u8fde\u63a5","completed":"\u6865\u63a5\u7ef4\u62a4\u5df2\u5b8c\u6210","failed":"\u6865\u63a5\u7ef4\u62a4\u672a\u5b8c\u6210","cancelled":"\u6865\u63a5\u7ef4\u62a4\u5df2\u53d6\u6d88","working":"\u8bf7\u7a0d\u5019\u3002","finished":"\u64cd\u4f5c\u5df2\u5b8c\u6210\u3002","reopened":"DSH \u5df2\u91cd\u65b0\u542f\u52a8\u3002","retry":"\u53ef\u8fd4\u56de DSH \u8bbe\u7f6e\u67e5\u770b\u7ed3\u679c\u5e76\u91cd\u8bd5\u3002","elapsed":"\u5df2\u7528\u65f6"}' | ConvertFrom-Json
  } else {
    '{"window":"DSH - Browser bridge","armed":"Preparing maintenance","closing":"Closing DSH normally","installing":"Installing the browser bridge","uninstalling":"Removing the browser bridge","restarting":"Starting DSH","verifying":"Checking the connection","completed":"Bridge maintenance completed","failed":"Bridge maintenance did not finish","cancelled":"Bridge maintenance cancelled","working":"Please wait.","finished":"The operation is complete.","reopened":"DSH has restarted.","retry":"Return to DSH settings to review the result and retry.","elapsed":"Elapsed"}' | ConvertFrom-Json
  }
  $script:form = [DshBridgeMaintenance.ProgressWindow]::new($copy.window)
  $script:watch = [Diagnostics.Stopwatch]::StartNew()
  $script:initialElapsedMs = 0
  $script:startedUtc = $null
  $script:frozenElapsedMs = $null
  try {
    if ($script:lastState.PSObject.Properties.Name -contains 'startedAt') {
      $started = [DateTimeOffset]::Parse([string]$script:lastState.startedAt, [Globalization.CultureInfo]::InvariantCulture)
      $script:initialElapsedMs = [Math]::Max(0, ([DateTimeOffset]::UtcNow - $started).TotalMilliseconds)
      $script:startedUtc = $started
    }
  } catch { }
  $script:completionAt = $null
  $script:timer = [Windows.Forms.Timer]::new()
  $script:timer.Interval = 500
  $refresh = {
    try {
      $state = Read-ProgressState
      if ($null -ne $state) { $script:lastState = $state }
      $phase = [string]$script:lastState.phase
      if ($phase -eq 'complete') { $phase = 'completed' }
      $key = if ($phase -eq 'installing' -and $script:lastState.action -eq 'uninstall') { 'uninstalling' } else { $phase }
      $terminal = @('completed', 'failed', 'cancelled') -contains $phase
      $message = if ($phase -eq 'completed') {
        if ($script:lastState.PSObject.Properties.Name -contains 'restarted' -and $script:lastState.restarted -eq $true) { $copy.reopened } else { $copy.finished }
      } elseif ($terminal) { $copy.retry } else { $copy.working }
      $elapsedMs = $script:initialElapsedMs + $script:watch.ElapsedMilliseconds
      if ($terminal -and $null -eq $script:frozenElapsedMs) {
        $script:frozenElapsedMs = $elapsedMs
        try {
          if ($null -ne $script:startedUtc -and $script:lastState.PSObject.Properties.Name -contains 'at') {
            $terminalAt = [DateTimeOffset]::Parse([string]$script:lastState.at, [Globalization.CultureInfo]::InvariantCulture)
            $script:frozenElapsedMs = [Math]::Max(0, [Math]::Min($elapsedMs, ($terminalAt - $script:startedUtc).TotalMilliseconds))
          }
        } catch { }
      }
      if ($null -ne $script:frozenElapsedMs) { $elapsedMs = $script:frozenElapsedMs }
      $span = [TimeSpan]::FromMilliseconds($elapsedMs)
      $time = '{0} {1:00}:{2:00}' -f $copy.elapsed, [Math]::Floor($span.TotalMinutes), $span.Seconds
      $script:form.UpdateStage([string]$copy.$key, [string]$message, $time, -not $terminal, $phase -eq 'failed')
      if ($phase -eq 'completed' -and $null -eq $script:completionAt) { $script:completionAt = $script:watch.ElapsedMilliseconds + 6000 }
      if (($null -ne $script:completionAt -and $script:watch.ElapsedMilliseconds -ge $script:completionAt) -or $script:watch.ElapsedMilliseconds -ge 600000) { $script:form.Close() }
    } catch {
      # State files are atomically replaced during maintenance. Keep the last
      # verified state through a transient read or accessibility repaint failure.
      if ($script:watch.ElapsedMilliseconds -ge 600000) { $script:form.Close() }
    }
  }
  & $refresh
  $script:timer.add_Tick($refresh)
  $script:form.add_FormClosed({ $script:timer.Stop(); $script:timer.Dispose() })
  $script:timer.Start()
  [Windows.Forms.Application]::Run($script:form)
  $script:form.Dispose()
  Write-Output (@{ ok = $true; id = $JobId; action = 'progress-window-closed' } | ConvertTo-Json -Compress)
} catch { Stop-Progress 'PROGRESS_UNAVAILABLE' }
