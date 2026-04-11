[[ -n "$KOJI_SHELL_INTEGRATION" ]] || return 0

[[ -n "$KOJI_ORIG_ZDOTDIR" ]] && ZDOTDIR="$KOJI_ORIG_ZDOTDIR"
unset KOJI_ORIG_ZDOTDIR

_koji_precmd() {
    local ec=$?
    [[ -n "$_koji_cmd_started" ]] && printf '\e]133;D;%d\a' "$ec"
    _koji_cmd_started=
    printf '\e]7;file://%s%s\a' "${HOST:-$(hostname)}" "$PWD"
    printf '\e]133;A\a'
}

_koji_preexec() {
    _koji_cmd_started=1
    printf '\e]133;C\a'
}

_koji_zle_line_init() { printf '\e]133;B\a'; }

autoload -Uz add-zsh-hook
add-zsh-hook precmd _koji_precmd
add-zsh-hook preexec _koji_preexec
zle -N zle-line-init _koji_zle_line_init
