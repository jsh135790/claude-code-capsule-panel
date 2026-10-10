#!/usr/bin/env bash
# =============================================================================
# Claude Code Status Line — Catppuccin Mocha capsules with Nerd Font icons
#    model · effort    dir    git    ctx%    cost    vim
# One jq call and one git call per draw; usage detail lives in the
# capsule-panel plugin. Respects NO_COLOR.
# =============================================================================

set -u

INPUT=$(cat)

# ---------------------------------------------------------------------------
# 0. jq — prefer PATH, fall back to known install locations
# ---------------------------------------------------------------------------
JQ=""
if command -v jq >/dev/null 2>&1; then
  JQ="jq"
else
  for _cand in \
    "${HOME:-}/AppData/Local/Microsoft/WinGet/Links/jq.exe" \
    "/usr/bin/jq" "/usr/local/bin/jq" "/opt/homebrew/bin/jq"; do
    if [[ -x "$_cand" ]]; then JQ="$_cand"; break; fi
  done
fi

# ---------------------------------------------------------------------------
# 1. Every field in one jq pass, joined by the unit separator so empty
#    fields survive the read.
# ---------------------------------------------------------------------------
FIELDS=""
if [[ -n "$JQ" ]]; then
  FIELDS=$(printf '%s' "$INPUT" | "$JQ" -r '
    [ (.model.display_name // "" | sub("^Claude "; "") | sub(" ?\\(1M context\\)"; " 1M")),
      .effort.level,
      .thinking.enabled,
      (.cwd // .workspace.current_dir),
      (.worktree.branch // .workspace.git_worktree),
      .pr.number,
      .context_window.used_percentage,
      .cost.total_cost_usd,
      .vim.mode
    ] | map(if . == null then "" else tostring end) | join("\u001f")' 2>/dev/null)
fi
IFS=$'\x1f' read -r MODEL EFFORT THINKING CWD WT_BRANCH PR_NUM CTX COST VIM <<<"$FIELDS"

# ---------------------------------------------------------------------------
# 2. Git — branch, ahead/behind and dirty from one porcelain v2 status
# ---------------------------------------------------------------------------
BRANCH="" AHEAD=0 BEHIND=0 DIRTY=0
if [[ -n "$CWD" ]] && command -v git >/dev/null 2>&1; then
  GIT_OUT=$(git -C "$CWD" --no-optional-locks status --porcelain=v2 --branch 2>/dev/null) || GIT_OUT=""
  while IFS= read -r line; do
    case $line in
      '# branch.head '*) BRANCH=${line#'# branch.head '} ;;
      '# branch.ab '*)
        ab=${line#'# branch.ab '}
        AHEAD=${ab%% *}; AHEAD=${AHEAD#+}
        BEHIND=${ab##* }; BEHIND=${BEHIND#-} ;;
      '#'*) ;;
      ?*) DIRTY=1 ;;
    esac
  done <<<"$GIT_OUT"
fi
[[ -z "$BRANCH" ]] && BRANCH=$WT_BRANCH
[[ "$BRANCH" == "(detached)" ]] && BRANCH="detached"
(( ${#BRANCH} > 24 )) && BRANCH="${BRANCH:0:23}…"

# ---------------------------------------------------------------------------
# 3. Directory — last component, home shown as ~
# ---------------------------------------------------------------------------
DIR=""
if [[ -n "$CWD" ]]; then
  path=${CWD//\\//}
  path=${path%/}
  home=${USERPROFILE:-${HOME:-}}
  home=${home//\\//}
  if [[ -n "$home" && ( "${path,,}" == "${home,,}" || "${path,,}" == "/c${home:2}" ) ]]; then
    DIR="~"
  else
    DIR=${path##*/}
    [[ -z "$DIR" ]] && DIR=$path
  fi
fi

# ---------------------------------------------------------------------------
# 4. Numbers
# ---------------------------------------------------------------------------
CTX_INT=""
[[ -n "$CTX" ]] && printf -v CTX_INT '%.0f' "$CTX" 2>/dev/null
COST_FMT=""
[[ -n "$COST" ]] && printf -v COST_FMT '%.2f' "$COST" 2>/dev/null

# ---------------------------------------------------------------------------
# 5. Draw
# ---------------------------------------------------------------------------
I_MODEL=$'\xf3\xb0\x99\xb4' I_THINK=$'\xf3\xb0\xa7\x91' I_DIR=$'\xef\x81\xbc' I_GIT=$'\xee\x82\xa0' I_DIRTY=$'\xef\x91\x84' I_PR=$'\xef\x90\x87'
I_CTX=$'\xf3\xb0\x8d\x9b' I_COST=$'\xef\x85\x95' I_VIM=$'\xee\x98\xab'
CAP_L=$'\xee\x82\xb6' CAP_R=$'\xee\x82\xb4'

if [[ -n "${NO_COLOR:-}" ]]; then
  OUT=""
  add() { OUT+="${OUT:+ │ }$*"; }
  [[ -n "$MODEL" ]] && add "$MODEL${EFFORT:+ · $EFFORT}"
  [[ -n "$DIR" ]] && add "$DIR"
  [[ -n "$BRANCH" ]] && add "$BRANCH$( ((DIRTY)) && printf '*')"
  [[ -n "$CTX_INT" ]] && add "ctx $CTX_INT%"
  [[ -n "$COST_FMT" ]] && add "\$$COST_FMT"
  [[ -n "$VIM" ]] && add "$VIM"
  [[ -n "$OUT" ]] && printf '%s\n' "$OUT"
  exit 0
fi

E=$'\033'
INK="30;30;46"          # base — text on every capsule
DIM_INK="69;71;90"      # surface1 — secondary text on a capsule
MAUVE="203;166;247" BLUE="137;180;250" GREEN="166;227;161" YELLOW="249;226;175"
RED="243;139;168" PEACH="250;179;135" LAVENDER="180;190;254"

OUT=""
# pill <bg rgb> <icon> <bold text> [secondary text]
pill() {
  OUT+="${OUT:+ }${E}[38;2;${1}m${CAP_L}${E}[48;2;${1}m${E}[38;2;${INK}m${2} ${E}[1m${3}${E}[22m"
  [[ -n "${4:-}" ]] && OUT+="${E}[38;2;${DIM_INK}m ${4}"
  OUT+="${E}[0m${E}[38;2;${1}m${CAP_R}${E}[0m"
}

if [[ -n "$MODEL" ]]; then
  extra=""
  [[ -n "$EFFORT" ]] && extra="· $EFFORT"
  [[ "$THINKING" == "true" ]] && extra+="${extra:+ }$I_THINK"
  pill "$MAUVE" "$I_MODEL" "$MODEL" "$extra"
fi

[[ -n "$DIR" ]] && pill "$BLUE" "$I_DIR" "$DIR"

if [[ -n "$BRANCH" ]]; then
  extra=""
  (( DIRTY )) && extra+="$I_DIRTY"
  (( AHEAD > 0 )) && extra+="${extra:+ }↑$AHEAD"
  (( BEHIND > 0 )) && extra+="${extra:+ }↓$BEHIND"
  [[ -n "$PR_NUM" ]] && extra+="${extra:+ }$I_PR $PR_NUM"
  pill "$GREEN" "$I_GIT" "$BRANCH" "$extra"
fi

if [[ -n "$CTX_INT" ]]; then
  ctx_bg=$GREEN
  (( CTX_INT >= 50 )) && ctx_bg=$YELLOW
  (( CTX_INT >= 80 )) && ctx_bg=$RED
  pill "$ctx_bg" "$I_CTX" "$CTX_INT%"
fi

[[ -n "$COST_FMT" ]] && pill "$PEACH" "$I_COST" "$COST_FMT"
[[ -n "$VIM" ]] && pill "$LAVENDER" "$I_VIM" "$VIM"

[[ -n "$OUT" ]] && printf '%s\n' "$OUT"
exit 0
