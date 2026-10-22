# Source this file from Bash or zsh: source ~/projects/robotics-data-collection/scripts/env.sh

export ROBOTICS_CAPTURE_ROOT="${ROBOTICS_CAPTURE_ROOT:-$HOME/projects/robotics-data-collection}"
export ROBOTICS_CAPTURE_TOOLS="${ROBOTICS_CAPTURE_TOOLS:-$HOME/.local/share/robotics-capture-tools}"
export ROBOTICS_CAPTURE_JAVA_HOME="${ROBOTICS_CAPTURE_JAVA_HOME:-$ROBOTICS_CAPTURE_TOOLS/jdk21}"

export ANDROID_HOME="$ROBOTICS_CAPTURE_TOOLS/android-sdk"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
export ANDROID_USER_HOME="$ANDROID_HOME/.android"
export JAVA_HOME="$ROBOTICS_CAPTURE_JAVA_HOME"
export PATH="$JAVA_HOME/bin:$ROBOTICS_CAPTURE_TOOLS/flutter/bin:$ANDROID_HOME/platform-tools:$ANDROID_HOME/cmdline-tools/latest/bin:$PATH"
