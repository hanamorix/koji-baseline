_koji_real_zdotdir="${KOJI_ORIG_ZDOTDIR:-$HOME}"
[[ -f "$_koji_real_zdotdir/.zshenv" ]] && source "$_koji_real_zdotdir/.zshenv"
source "${KOJI_SHELL_INTEGRATION_DIR}/koji.zsh"
unset _koji_real_zdotdir
