package ai.stateaction.spike.capture

import android.opengl.*
import android.view.Surface
import com.google.ar.core.Coordinates2d
import com.google.ar.core.Frame
import java.nio.ByteBuffer
import java.nio.ByteOrder

/** One GL context samples ARCore OES directly into the hardware encoder Surface. */
class CaptureGl {
    private val display = EGL14.eglGetDisplay(EGL14.EGL_DEFAULT_DISPLAY)
    private val config: EGLConfig
    private val context: EGLContext
    private val pbuffer: EGLSurface
    private var encoderWindow: EGLSurface? = null
    val texture: Int
    private val program: Int
    private val vertices = floats(floatArrayOf(-1f,-1f, 1f,-1f, -1f,1f, 1f,1f))
    private val imageCorners = floatArrayOf(0f,1f, 1f,1f, 0f,0f, 1f,0f)
    private val textureCorners = FloatArray(8)
    init {
        check(EGL14.eglInitialize(display, IntArray(2),0,IntArray(2),1))
        val configs = arrayOfNulls<EGLConfig>(1)
        check(EGL14.eglChooseConfig(display, intArrayOf(EGL14.EGL_RED_SIZE,8,EGL14.EGL_GREEN_SIZE,8,EGL14.EGL_BLUE_SIZE,8,EGL14.EGL_RENDERABLE_TYPE,EGL14.EGL_OPENGL_ES2_BIT,EGL14.EGL_SURFACE_TYPE,EGL14.EGL_WINDOW_BIT or EGL14.EGL_PBUFFER_BIT,0x3142,1,EGL14.EGL_NONE),0,configs,0,1,IntArray(1),0))
        config = checkNotNull(configs[0])
        context = EGL14.eglCreateContext(display,config,EGL14.EGL_NO_CONTEXT,intArrayOf(EGL14.EGL_CONTEXT_CLIENT_VERSION,2,EGL14.EGL_NONE),0)
        check(context != EGL14.EGL_NO_CONTEXT)
        pbuffer = EGL14.eglCreatePbufferSurface(display,config,intArrayOf(EGL14.EGL_WIDTH,1,EGL14.EGL_HEIGHT,1,EGL14.EGL_NONE),0)
        idle()
        val names = IntArray(1); GLES20.glGenTextures(1,names,0); texture=names[0]
        GLES20.glBindTexture(GLES11Ext.GL_TEXTURE_EXTERNAL_OES,texture)
        GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES,GLES20.GL_TEXTURE_MIN_FILTER,GLES20.GL_LINEAR)
        GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES,GLES20.GL_TEXTURE_MAG_FILTER,GLES20.GL_LINEAR)
        GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES,GLES20.GL_TEXTURE_WRAP_S,GLES20.GL_CLAMP_TO_EDGE)
        GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES,GLES20.GL_TEXTURE_WRAP_T,GLES20.GL_CLAMP_TO_EDGE)
        val vertex = shader(GLES20.GL_VERTEX_SHADER,"attribute vec2 position; attribute vec2 uv; varying vec2 tex; void main(){ gl_Position=vec4(position,0.,1.);tex=uv; }")
        val fragment = shader(GLES20.GL_FRAGMENT_SHADER,"#extension GL_OES_EGL_image_external : require\nprecision mediump float; uniform samplerExternalOES camera; varying vec2 tex; void main(){gl_FragColor=texture2D(camera,tex);}")
        program = GLES20.glCreateProgram(); GLES20.glAttachShader(program,vertex); GLES20.glAttachShader(program,fragment); GLES20.glLinkProgram(program)
        val result = IntArray(1); GLES20.glGetProgramiv(program,GLES20.GL_LINK_STATUS,result,0); check(result[0]!=0) { GLES20.glGetProgramInfoLog(program) }
        GLES20.glDeleteShader(vertex); GLES20.glDeleteShader(fragment)
    }
    private fun shader(type: Int, src: String): Int {
        val s=GLES20.glCreateShader(type); GLES20.glShaderSource(s,src); GLES20.glCompileShader(s)
        val result=IntArray(1); GLES20.glGetShaderiv(s,GLES20.GL_COMPILE_STATUS,result,0); check(result[0]!=0) { GLES20.glGetShaderInfoLog(s) }; return s
    }
    fun attach(surface: Surface) {
        encoderWindow=EGL14.eglCreateWindowSurface(display,config,surface,intArrayOf(EGL14.EGL_NONE),0)
        check(encoderWindow != EGL14.EGL_NO_SURFACE)
    }
    fun idle() { check(EGL14.eglMakeCurrent(display,pbuffer,pbuffer,context)) }
    fun draw(frame: Frame, ptsUs: Long, width: Int, height: Int): FloatArray {
        frame.transformCoordinates2d(Coordinates2d.IMAGE_NORMALIZED,imageCorners,Coordinates2d.TEXTURE_NORMALIZED,textureCorners)
        val window=checkNotNull(encoderWindow)
        check(EGL14.eglMakeCurrent(display,window,window,context))
        GLES20.glViewport(0,0,width,height); GLES20.glUseProgram(program)
        GLES20.glActiveTexture(GLES20.GL_TEXTURE0); GLES20.glBindTexture(GLES11Ext.GL_TEXTURE_EXTERNAL_OES,texture)
        GLES20.glUniform1i(GLES20.glGetUniformLocation(program,"camera"),0)
        val p=GLES20.glGetAttribLocation(program,"position"); val u=GLES20.glGetAttribLocation(program,"uv")
        GLES20.glEnableVertexAttribArray(p); GLES20.glVertexAttribPointer(p,2,GLES20.GL_FLOAT,false,0,vertices)
        GLES20.glEnableVertexAttribArray(u); GLES20.glVertexAttribPointer(u,2,GLES20.GL_FLOAT,false,0,floats(textureCorners))
        GLES20.glDrawArrays(GLES20.GL_TRIANGLE_STRIP,0,4)
        check(GLES20.glGetError()==GLES20.GL_NO_ERROR) { "GL draw failed" }
        check(EGLExt.eglPresentationTimeANDROID(display,window,ptsUs*1000L))
        check(EGL14.eglSwapBuffers(display,window)) { "Encoder EGL swap failed" }
        idle()
        return textureCorners.copyOf()
    }
    fun close() {
        idle(); GLES20.glDeleteProgram(program); GLES20.glDeleteTextures(1,intArrayOf(texture),0)
        encoderWindow?.let { EGL14.eglDestroySurface(display,it) }
        EGL14.eglDestroySurface(display,pbuffer); EGL14.eglMakeCurrent(display,EGL14.EGL_NO_SURFACE,EGL14.EGL_NO_SURFACE,EGL14.EGL_NO_CONTEXT)
        EGL14.eglDestroyContext(display,context); EGL14.eglTerminate(display)
    }
    companion object {
        private fun floats(values: FloatArray) = ByteBuffer.allocateDirect(values.size*4).order(ByteOrder.nativeOrder()).asFloatBuffer().apply { put(values); position(0) }
    }
}
