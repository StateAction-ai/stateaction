import java.util.Base64
import java.util.Properties
import java.io.FileInputStream

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
val qaPackage = "ai.stateaction.collector.qa"
val qaAutoSignIn = (project.findProperty("dart-defines") as? String)
    ?.split(",")
    ?.filter { it.isNotEmpty() }
    ?.any { String(Base64.getDecoder().decode(it), Charsets.UTF_8) == "STATEACTION_QA_AUTO_SIGN_IN=true" }
    ?: false
require(qaAutoSignIn == (stateactionApplicationId == qaPackage)) {
    "QA auto sign-in and the dedicated QA application ID must be selected together"
}
if (qaAutoSignIn) require(nativeUploadQualification) {
    "The QA application requires the native upload gate"
}

androidComponents {
    beforeVariants(selector().all()) { variant ->
        if (qaAutoSignIn && variant.buildType != "debug") variant.enable = false
    }
}

if (nativeUploadCleartext) {
    require(nativeUploadQualification) {
        "stateactionNativeUploadCleartext requires stateactionNativeUpload=true"
    }
    require(stateactionApplicationId == "ai.stateaction.collector.e2e" || qaAutoSignIn) {
        "stateactionNativeUploadCleartext is only allowed for dedicated E2E or QA builds"
    }
}

android {
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
}
