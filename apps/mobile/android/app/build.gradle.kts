import java.util.Properties
import java.io.FileInputStream
import java.net.URI
import java.security.MessageDigest
import groovy.json.JsonSlurper

plugins {
    id("com.android.application")
    id("kotlin-android")
    // The Flutter Gradle Plugin must be applied after the Android and Kotlin Gradle plugins.
    id("dev.flutter.flutter-gradle-plugin")
}

// ✅ Load keystore properties
val keystoreProperties = Properties()
val keystorePropertiesFile = rootProject.file("key.properties")
if (keystorePropertiesFile.exists()) {
    keystoreProperties.load(FileInputStream(keystorePropertiesFile))
}

// Optional separate identity for StateAction development installs (for example
// -PstateactionApplicationId=ai.stateaction.collector.dev), so a test build never
// replaces or reads the existing collector's package and data. Unset keeps the
// default identity unchanged.
val stateactionApplicationId = (project.findProperty("stateactionApplicationId") as String?)?.also {
    require(Regex("ai\\.stateaction\\.[a-z][a-z0-9_]*(\\.[a-z][a-z0-9_]*)*").matches(it)) {
        "stateactionApplicationId must be an ai.stateaction.* package name"
    }
}
val stateactionAppLabel = (project.findProperty("stateactionAppLabel") as String?)?.also {
    require(Regex("[A-Za-z0-9 ._-]{1,40}").matches(it)) { "stateactionAppLabel must be 1-40 plain characters" }
}

// Two independent, explicit, debug-only switches. The placeholders default to
// false and only the debug manifest overlay reads them, so no release build can
// carry the gate or cleartext loopback.
//  - -PstateactionNativeUpload=true (or ORG_GRADLE_PROJECT_stateactionNativeUpload)
//    turns the owner-bound native uploader gate on (a real-device HTTPS build
//    uses only this one).
//  - -PstateactionNativeUploadCleartext=true additionally allows the emulator's
//    cleartext loopback backend. It is refused unless the uploader gate is on
//    AND the dedicated ai.stateaction.collector.e2e package is used.
val nativeUploadQualification =
    (project.findProperty("stateactionNativeUpload") as String?) == "true"
val nativeUploadCleartext =
    (project.findProperty("stateactionNativeUploadCleartext") as String?) == "true"
if (nativeUploadCleartext) {
    require(nativeUploadQualification) {
        "stateactionNativeUploadCleartext requires stateactionNativeUpload=true"
    }
    require(stateactionApplicationId == "ai.stateaction.collector.e2e") {
        "stateactionNativeUploadCleartext is only allowed for ai.stateaction.collector.e2e"
    }
}

val handModelManifest = file("../../../../workers/processing/src/stateaction_processing/hand_model.json")
val handModelAssets = layout.buildDirectory.dir("generated/hand-model/assets")
val prepareHandModel by tasks.registering {
    inputs.file(handModelManifest)
    outputs.dir(handModelAssets)
    doLast {
        val manifest = JsonSlurper().parse(handModelManifest) as Map<*, *>
        val target = handModelAssets.get().file(manifest["file"].toString()).asFile
        val expected = manifest["bytes"].toString().toInt()
        val connection = URI(manifest["url"].toString()).toURL().openConnection()
        connection.connectTimeout = 15_000
        connection.readTimeout = 30_000
        val bytes = connection.getInputStream().use { it.readNBytes(expected + 1) }
        val digest = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
        check(bytes.size == expected && digest == manifest["sha256"]) { "Hand Landmarker failed checksum verification" }
        target.parentFile.mkdirs()
        target.writeBytes(bytes)
    }
}
tasks.named("preBuild").configure { dependsOn(prepareHandModel) }

android {
    sourceSets.getByName("main").assets.srcDir(handModelAssets)
    namespace = "open.fpvlabs.stera"
    compileSdk = flutter.compileSdkVersion
    ndkVersion = flutter.ndkVersion

    // ✅ Signing configuration
    signingConfigs {
        create("release") {
            keyAlias = keystoreProperties.getProperty("keyAlias")
            keyPassword = keystoreProperties.getProperty("keyPassword")
            storeFile = keystoreProperties.getProperty("storeFile")?.let { file(it) }
            storePassword = keystoreProperties.getProperty("storePassword")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
        isCoreLibraryDesugaringEnabled = true
    }

    kotlinOptions {
        jvmTarget = JavaVersion.VERSION_17.toString()
    }

    defaultConfig {
        applicationId = stateactionApplicationId ?: "open.fpvlabs.stera"
        manifestPlaceholders["appLabel"] = stateactionAppLabel
            ?: if (stateactionApplicationId != null) "StateAction Dev" else "@string/app_name_short"
        minSdk = flutter.minSdkVersion
        targetSdk = flutter.targetSdkVersion
        versionCode = flutter.versionCode
        versionName = flutter.versionName
        manifestPlaceholders["nativeUploadEnabled"] = nativeUploadQualification.toString()
        manifestPlaceholders["nativeUploadCleartext"] = nativeUploadCleartext.toString()
    }

    buildTypes {
        release {
            signingConfig = signingConfigs.getByName("release")
            isMinifyEnabled = true           // optional (shrinks/optimizes code)
            isShrinkResources = true         // optional (removes unused resources)
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
    }

    // Ensure all packages respect manifest merger rules
    packagingOptions {
        resources {
            excludes += "/META-INF/{AL2.0,LGPL2.1}"
        }
    }
}

flutter {
    source = "../.."
}

dependencies {
    coreLibraryDesugaring("com.android.tools:desugar_jdk_libs:2.1.4")
    implementation("com.google.mediapipe:tasks-vision:0.10.32")
    testImplementation("junit:junit:4.13.2")
}
