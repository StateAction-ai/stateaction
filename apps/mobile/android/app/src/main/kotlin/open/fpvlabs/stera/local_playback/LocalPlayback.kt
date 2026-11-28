package open.fpvlabs.stera.local_playback

internal interface LocalPlayback {
    fun start(): String
    fun append(id: String, unit: ByteArray, ptsUs: Long, width: Int, height: Int)
    fun finish(id: String): String
    fun discard(id: String)
    fun dispose()
}
