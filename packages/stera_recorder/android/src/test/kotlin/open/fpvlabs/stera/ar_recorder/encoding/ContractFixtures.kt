package open.fpvlabs.stera.ar_recorder.encoding

import java.io.File

/** Locates the published SA-50 contract directory from the test working directory (never copied). */
object ContractFixtures {
    val captureDir: File by lazy {
        var dir: File? = File(System.getProperty("user.dir")).absoluteFile
        while (dir != null && !File(dir, "packages/contracts/capture/manifest.json").isFile) dir = dir.parentFile
        File(checkNotNull(dir) { "Repository root with packages/contracts/capture not found" }, "packages/contracts/capture")
    }
}
