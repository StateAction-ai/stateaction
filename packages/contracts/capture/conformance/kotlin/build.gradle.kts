// JVM-only conformance project: compiles the production Android pure-Kotlin protocol sources
// (data/h264/CaptureProtocol.kt and VideoWire.kt, no Android dependency) against the golden MCAP files.
plugins {
    kotlin("jvm") version "2.1.0"
}

repositories { mavenCentral() }

kotlin { jvmToolchain(21) }

sourceSets {
    main {
        kotlin.srcDir("../../../../stera_recorder/android/src/main/kotlin/open/fpvlabs/stera/ar_recorder/data/h264")
    }
}

dependencies {
    testImplementation(kotlin("test"))
    testImplementation("org.json:json:20250517")
}

tasks.test {
    useJUnit()
    systemProperty("capture.dir", file("../..").absolutePath)
    testLogging { events("passed", "failed", "skipped"); showStandardStreams = true }
}
