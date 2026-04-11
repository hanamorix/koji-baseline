test -n "$KOJI_SHELL_INTEGRATION"; or exit 0

set -g _koji_cmd_started ""

function _koji_prompt --on-event fish_prompt
    set -l ec $status
    test -n "$_koji_cmd_started"; and printf '\e]133;D;%d\a' $ec
    set -g _koji_cmd_started ""
    printf '\e]7;file://%s%s\a' (hostname) "$PWD"
    printf '\e]133;A\a'
    printf '\e]133;B\a'
end

function _koji_preexec --on-event fish_preexec
    set -g _koji_cmd_started "1"
    printf '\e]133;C\a'
end
