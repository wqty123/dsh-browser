<#
Requests the verified Desktop process's own native Quit menu action.
The caller opens the official application menu after starting this helper.
This helper never dismisses or approves a subsequent task confirmation.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateRange(1, 2147483647)]
  [int]$TargetPid,

  [Parameter(Mandatory = $true)]
  [ValidateNotNullOrEmpty()]
  [string]$ExpectedExecutable,

  [ValidateRange(1, 120)]
  [int]$TimeoutSeconds = 15,

  # Pass the UTC CreationDate from the coordinator's original Win32_Process
  # snapshot to also detect PID reuse before this helper starts.
  [string]$ExpectedStartTimeUtc
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding

function Complete-Request([hashtable]$Result, [int]$Code) {
  $Result['pid'] = $TargetPid
  Write-Output ($Result | ConvertTo-Json -Compress -Depth 4)
  exit $Code
}

function Fail-Request([string]$Code, [string]$Message) {
  Complete-Request @{ ok = $false; code = $Code; error = $Message } 1
}

function Read-TargetProcess {
  # Read only this exact PID. Do not collect CommandLine or inspect unrelated
  # Desktop installations, browser guests, or other applications.
  return Get-CimInstance -ClassName Win32_Process -Filter ('ProcessId = ' + $TargetPid.ToString([Globalization.CultureInfo]::InvariantCulture)) -Property ProcessId, ExecutablePath, CreationDate -OperationTimeoutSec 3
}

function Read-CreationTicks($Process) {
  if ($null -eq $Process.CreationDate) {
    Fail-Request 'PROCESS_IDENTITY_UNAVAILABLE' 'The target process creation time is unavailable; no quit action was sent.'
  }
  return $Process.CreationDate.ToUniversalTime().Ticks
}

function Assert-TargetIdentity($Process, [long]$CreationTicks) {
  if ([string]::IsNullOrWhiteSpace($Process.ExecutablePath)) {
    Fail-Request 'PROCESS_IDENTITY_UNAVAILABLE' 'The target executable could not be verified; no quit action was sent.'
  }
  $actualPath = [IO.Path]::GetFullPath($Process.ExecutablePath)
  if (-not [StringComparer]::OrdinalIgnoreCase.Equals($script:verifiedExecutable, $actualPath)) {
    Fail-Request 'PROCESS_IDENTITY_MISMATCH' 'The PID belongs to a different executable; no quit action was sent.'
  }
  if ((Read-CreationTicks $Process) -ne $CreationTicks) {
    Fail-Request 'PID_REUSED' 'The original process has exited and its PID was reused; no quit action was sent.'
  }
}

function Test-NativePopupItem($Element) {
  # Native Electron popup rows have these Views accessibility classes. Requiring
  # the native popup root keeps an HTML role=menuitem out of the candidate set.
  $current = $Element.Current
  if ($current.ClassName -ne 'MenuItemView' -or $current.FrameworkId -ne 'Chrome') { return $false }
  $ancestor = [Windows.Automation.TreeWalker]::RawViewWalker.GetParent($Element)
  $foundMenuRoot = $false
  for ($depth = 0; $depth -lt 32 -and $null -ne $ancestor; $depth++) {
    $information = $ancestor.Current
    if ($information.ProcessId -ne $TargetPid) { return $false }
    if ($information.ControlType -eq [Windows.Automation.ControlType]::Document) { return $false }
    if ($information.ClassName -eq 'MenuHostRootView' -and $information.FrameworkId -eq 'Chrome') { $foundMenuRoot = $true }
    if ($foundMenuRoot -and $information.NativeWindowHandle -ne 0 -and $information.ClassName -match '^Chrome_WidgetWin_') { return $true }
    $ancestor = [Windows.Automation.TreeWalker]::RawViewWalker.GetParent($ancestor)
  }
  return $false
}

try {
  if ($env:DSH_BROWSER_TEST -eq '1' -or $null -ne $env:NODE_TEST_CONTEXT) {
    Fail-Request 'TEST_CONTEXT_REFUSED' 'Native Desktop quit requests are disabled in automated test contexts.'
  }
  if ($ExpectedExecutable -notmatch '^(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+[\\/])') {
    Fail-Request 'INVALID_EXECUTABLE' 'ExpectedExecutable must be an absolute Windows executable path.'
  }
  $script:verifiedExecutable = [IO.Path]::GetFullPath($ExpectedExecutable)
  $file = Get-Item -LiteralPath $script:verifiedExecutable
  if ($file.PSIsContainer -or $file.Extension -ine '.exe') {
    Fail-Request 'INVALID_EXECUTABLE' 'ExpectedExecutable must identify an existing executable file.'
  }

  $process = Read-TargetProcess
  if ($null -eq $process) {
    Complete-Request @{ ok = $true; alreadyExited = $true; action = 'already-exited' } 0
  }
  $creationTicks = Read-CreationTicks $process
  if (-not [string]::IsNullOrWhiteSpace($ExpectedStartTimeUtc)) {
    $expectedStart = [DateTimeOffset]::Parse($ExpectedStartTimeUtc, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind)
    if ($expectedStart.UtcTicks -ne $creationTicks) {
      Fail-Request 'PID_REUSED' 'The PID does not match the coordinator original process creation time; no quit action was sent.'
    }
  }
  Assert-TargetIdentity $process $creationTicks

  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName UIAutomationTypes
  # Official Windows application-menu labels in the shipped Desktop locales.
  # JSON escapes keep the script valid under Windows PowerShell's ANSI default.
  $labels = '["Exit","\u9000\u51fa","\u7d42\u4e86","Salir","Quitter","Beenden","\u0412\u044b\u0445\u043e\u0434","Sair","Quit DeepSeek Harness","\u9000\u51fa DeepSeek Harness"]' | ConvertFrom-Json
  $condition = [Windows.Automation.AndCondition]::new(
    [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ProcessIdProperty, $TargetPid),
    [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ControlTypeProperty, [Windows.Automation.ControlType]::MenuItem)
  )
  $watch = [Diagnostics.Stopwatch]::StartNew()
  while ($watch.Elapsed.TotalSeconds -lt $TimeoutSeconds) {
    $process = Read-TargetProcess
    if ($null -eq $process) {
      Complete-Request @{ ok = $true; alreadyExited = $true; action = 'already-exited' } 0
    }
    Assert-TargetIdentity $process $creationTicks
    $candidates = [Collections.Generic.List[object]]::new()
    $elements = [Windows.Automation.AutomationElement]::RootElement.FindAll([Windows.Automation.TreeScope]::Descendants, $condition)
    foreach ($element in $elements) {
      try {
        $current = $element.Current
        if (-not $current.IsEnabled -or $current.IsOffscreen -or $labels -cnotcontains $current.Name -or -not (Test-NativePopupItem $element)) { continue }
        $pattern = $null
        if ($element.TryGetCurrentPattern([Windows.Automation.InvokePattern]::Pattern, [ref]$pattern)) {
          $candidates.Add(@{ element = $element; pattern = $pattern; label = $current.Name })
        }
      } catch [Windows.Automation.ElementNotAvailableException] {
        # An unrelated disappearing menu is a transient view state.
      }
    }
    if ($candidates.Count -gt 1) {
      Fail-Request 'AMBIGUOUS_QUIT_MENU' 'More than one native quit menu item is open; no quit action was sent.'
    }
    if ($candidates.Count -eq 1) {
      $process = Read-TargetProcess
      if ($null -eq $process) {
        Complete-Request @{ ok = $true; alreadyExited = $true; action = 'already-exited' } 0
      }
      Assert-TargetIdentity $process $creationTicks
      $candidate = $candidates[0]
      $current = $candidate.element.Current
      if ($current.ProcessId -ne $TargetPid -or -not $current.IsEnabled -or $current.IsOffscreen -or $labels -cnotcontains $current.Name -or -not (Test-NativePopupItem $candidate.element)) { continue }
      try {
        $candidate.pattern.Invoke()
      } catch {
        $process = Read-TargetProcess
        if ($null -eq $process) {
          Complete-Request @{ ok = $true; alreadyExited = $true; action = 'already-exited' } 0
        }
        Assert-TargetIdentity $process $creationTicks
        Fail-Request 'QUIT_INVOKE_FAILED' 'The native quit menu action could not be invoked; no subsequent dialog was approved.'
      }
      Complete-Request @{ ok = $true; action = 'quit-requested'; method = 'uia-invoke'; label = $candidate.label } 0
    }
    Start-Sleep -Milliseconds 120
  }
  Fail-Request 'QUIT_MENU_TIMEOUT' 'The official native quit menu item was not available before the deadline. Open the Desktop application menu and retry.'
} catch {
  # Return stable diagnostics without serializing process command lines,
  # environment values, inaccessible executable paths, or UI content.
  Fail-Request 'QUIT_REQUEST_FAILED' 'The Desktop quit request could not be verified or UI Automation was unavailable; no subsequent dialog was approved.'
}
