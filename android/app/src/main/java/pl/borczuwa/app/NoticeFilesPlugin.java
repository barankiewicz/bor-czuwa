package pl.borczuwa.app;

import android.app.Activity;
import android.content.Intent;
import android.util.Base64;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.OutputStream;

@CapacitorPlugin(name = "NoticeFiles")
public class NoticeFilesPlugin extends Plugin {
    @PluginMethod
    public void save(PluginCall call) {
        String filename = call.getString("filename");
        String mimeType = call.getString("mimeType");
        if (filename == null || call.getString("base64") == null ||
            !("application/pdf".equals(mimeType) || "image/jpeg".equals(mimeType) ||
              "application/geo+json-seq".equals(mimeType))) {
            call.reject("invalid_notice_file");
            return;
        }
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType(mimeType);
        intent.putExtra(Intent.EXTRA_TITLE, filename);
        try { startActivityForResult(call, intent, "fileSelected"); }
        catch (Exception error) { call.reject("file_save_unavailable", error); }
    }

    @ActivityCallback
    private void fileSelected(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (result.getResultCode() != Activity.RESULT_OK) {
            call.resolve(new JSObject().put("saved", false));
            return;
        }
        getBridge().execute(() -> {
            try {
                if (result.getData() == null || result.getData().getData() == null) throw new IllegalStateException("missing_file_uri");
                byte[] bytes = Base64.decode(call.getString("base64"), Base64.DEFAULT);
                try (OutputStream stream = getContext().getContentResolver().openOutputStream(result.getData().getData(), "wt")) {
                    if (stream == null) throw new IllegalStateException("file_unavailable");
                    stream.write(bytes);
                }
                call.resolve(new JSObject().put("saved", true));
            } catch (Exception error) { call.reject("file_save_failed", error); }
        });
    }
}
