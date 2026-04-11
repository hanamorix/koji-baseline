[[ -n "$KOJI_SHELL_INTEGRATION" ]] || return 0

_koji_cmd_started=
_koji_prompt_command() {
    local ec=$?
    [[ -n "$_koji_cmd_started" ]] && printf '\e]133;D;%d\a' "$ec"
    _koji_cmd_started=
    printf '\e]7;file://%s%s\a' "$(hostname)" "$PWD"
    printf '\e]133;A\a'
}

_koji_preexec() {
    _koji_cmd_started=1
    printf '\e]133;C\a'
}

PROMPT_COMMAND="_koji_prompt_command${PROMPT_COMMAND:+;$PROMPT_COMMAND}"
trap '_koji_preexec' DEBUG
PS1="${PS1}\[\e]133;B\a\]"
