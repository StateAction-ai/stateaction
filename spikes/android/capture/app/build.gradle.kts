plugins { id("com.android.application"); id("org.jetbrains.kotlin.android") }
android {
    namespace = "ai.stateaction.spike.capture"
    compileSdk = 36
    defaultConfig {
        applicationId = "ai.stateaction.spike.capture"
        minSdk = 29
        targetSdk = 36
        versionCode = 1
        versionName = "0.1-spike"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }
    compileOptions { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }
    kotlinOptions { jvmTarget = "17" }
}
// MCAPWriterTest writes a fixture that a later verifier reads. Declare it as an output so a
// build-cache hit restores the file instead of skipping the test that creates it.
tasks.withType<org.gradle.api.tasks.testing.Test>().configureEach {
    outputs.dir(layout.buildDirectory.dir("spike-fixtures"))
}
dependencies {
    implementation("com.google.ar:core:1.44.0")
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test:runner:1.6.2")
    androidTestImplementation("androidx.test.ext:junit:1.2.1")
}
