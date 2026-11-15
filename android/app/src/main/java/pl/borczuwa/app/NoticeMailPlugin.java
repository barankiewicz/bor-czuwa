package pl.borczuwa.app;

import android.content.ClipData;
import android.content.Intent;
import android.net.Uri;
import android.util.Base64;
import androidx.activity.result.ActivityResult;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSArray;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.util.ArrayList;
import java.util.UUID;

@CapacitorPlugin(name = "NoticeMail")
public class NoticeMailPlugin extends Plugin {
    static void cleanExpired(File cache) throws IOException {
        File directory = new File(cache, "notice-mail");
        if (!directory.exists()) return;
        File[] copies = directory.listFiles();
        if (copies == null) throw new IOException("mail_cache_unavailable");
        long cutoff = System.currentTimeMillis() - 60 * 60 * 1000;
        for (File copy : copies) {
            if (copy.lastModified() < cutoff) deleteCopy(copy);
        }
    }

    private static void deleteCopy(File copy) throws IOException {
        if (copy.isDirectory()) {
            File[] children = copy.listFiles();
            if (children == null) throw new IOException("mail_cache_unavailable");
            for (File child : children) deleteCopy(child);
        }
        if (!copy.delete() && copy.exists()) throw new IOException("mail_cache_cleanup_failed");
    }

    @PluginMethod
    public void clear(PluginCall call) {
        try {
            File directory = new File(getContext().getCacheDir(), "notice-mail");
            if (directory.exists()) deleteCopy(directory);
            call.resolve();
        } catch (IOException error) {
            call.reject("mail_cache_cleanup_failed", error);
        }
    }

    @PluginMethod
    public void open(PluginCall call) {
        String address = call.getString("address");
        String subject = call.getString("subject");
        String body = call.getString("body");
        JSArray photos = call.getArray("photos", new JSArray());
        if (address == null || subject == null || body == null || photos == null || photos.length() > 3) {
            call.reject("invalid_notice_mail");
            return;
        }
        try {
            cleanExpired(getContext().getCacheDir());
            File directory = new File(getContext().getCacheDir(), "notice-mail/" + UUID.randomUUID());
            if (!directory.mkdirs()) throw new IllegalStateException("mail_cache_unavailable");
            ArrayList<Uri> attachments = new ArrayList<>();
            for (int index = 0; index < photos.length(); index++) {
                byte[] bytes = Base64.decode(photos.getString(index), Base64.DEFAULT);
                if (bytes.length > 8_000_000) throw new IllegalArgumentException("photo_too_large");
                File file = new File(directory, "zgloszenie-" + (index + 1) + ".jpg");
                try (FileOutputStream stream = new FileOutputStream(file)) { stream.write(bytes); }
                attachments.add(FileProvider.getUriForFile(getContext(),
                    getContext().getPackageName() + ".fileprovider", file));
            }
            Intent intent = new Intent(attachments.size() > 1 ? Intent.ACTION_SEND_MULTIPLE : Intent.ACTION_SEND);
            intent.setType(attachments.isEmpty() ? "message/rfc822" : "image/jpeg");
            intent.putExtra(Intent.EXTRA_EMAIL, new String[] { address });
            intent.putExtra(Intent.EXTRA_SUBJECT, subject);
            intent.putExtra(Intent.EXTRA_TEXT, body);
            if (!attachments.isEmpty()) {
                if (attachments.size() == 1) intent.putExtra(Intent.EXTRA_STREAM, attachments.get(0));
                else intent.putParcelableArrayListExtra(Intent.EXTRA_STREAM, attachments);
                ClipData clip = ClipData.newRawUri("notice-photo", attachments.get(0));
                for (int index = 1; index < attachments.size(); index++) clip.addItem(new ClipData.Item(attachments.get(index)));
                intent.setClipData(clip);
                intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            }
            startActivityForResult(call, Intent.createChooser(intent, "Wybierz aplikację pocztową"), "mailReturned");
        } catch (Exception error) {
            call.reject("mail_unavailable", error);
        }
    }

    @ActivityCallback
    private void mailReturned(PluginCall call, ActivityResult result) {
        call.resolve();
    }
}
