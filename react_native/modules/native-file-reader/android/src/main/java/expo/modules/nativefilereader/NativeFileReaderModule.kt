package expo.modules.nativefilereader

import android.net.Uri
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.Promise
import java.io.InputStream
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

class NativeFileReaderModule : Module() {

    private val handles = ConcurrentHashMap<String, InputStream>()

    override fun definition() = ModuleDefinition {
        Name("NativeFileReader")

        AsyncFunction("open") { uriString: String ->
            val context = appContext.reactContext
                ?: throw Exception("React context is unavailable")
            val uri = Uri.parse(uriString)
            val inputStream = context.contentResolver.openInputStream(uri)
                ?: throw Exception("Unable to open URI: $uriString")
            val handle = UUID.randomUUID().toString()
            handles[handle] = inputStream
            handle
        }

        AsyncFunction("read") { handle: String, size: Int ->
            if (size <= 0) {
                throw Exception("size must be greater than 0")
            }
            val inputStream = handles[handle]
                ?: throw Exception("Invalid or closed handle: $handle")
            val buffer = ByteArray(size)
            val count = inputStream.read(buffer)
            if (count == size) {
                return@AsyncFunction buffer
            }
            if (count < 0) {
                return@AsyncFunction null
            }
            buffer.copyOf(count)
        }

        AsyncFunction("close") { handle: String ->
            val inputStream = handles.remove(handle)
            inputStream?.close()
        }

        OnDestroy {
            handles.values.forEach {
                try {
                    it.close()
                } catch (_: Exception) {
                }
            }
            handles.clear()
        }
    }
}