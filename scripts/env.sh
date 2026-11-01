# Source this file from Bash or zsh: source ~/projects/robotics-data-collection/scripts/env.sh

if [[ -n "${ZSH_VERSION:-}" ]]; then
  _stateaction_env_file="${(%):-%x}"
else
  _stateaction_env_file="${BASH_SOURCE[0]}"
fi
_stateaction_env_root="$(cd -- "$(dirname -- "$_stateaction_env_file")/.." && pwd)"
export ROBOTICS_CAPTURE_ROOT="${ROBOTICS_CAPTURE_ROOT:-$_stateaction_env_root}"
unset _stateaction_env_file _stateaction_env_root
export ROBOTICS_CAPTURE_TOOLS="${ROBOTICS_CAPTURE_TOOLS:-$HOME/.local/share/robotics-capture-tools}"
export ROBOTICS_CAPTURE_JAVA_HOME="${ROBOTICS_CAPTURE_JAVA_HOME:-$ROBOTICS_CAPTURE_TOOLS/jdk21}"

export ANDROID_HOME="$ROBOTICS_CAPTURE_TOOLS/android-sdk"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
export ANDROID_USER_HOME="$ANDROID_HOME/.android"
export JAVA_HOME="$ROBOTICS_CAPTURE_JAVA_HOME"
export PATH="$JAVA_HOME/bin:$ROBOTICS_CAPTURE_TOOLS/flutter/bin:$ANDROID_HOME/platform-tools:$ANDROID_HOME/cmdline-tools/latest/bin:$PATH"
