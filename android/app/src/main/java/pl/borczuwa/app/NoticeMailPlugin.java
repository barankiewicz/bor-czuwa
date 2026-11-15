package pl.borczuwa.app;

import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
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
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
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

    static String authority(Context context) {
        return context.getPackageName() + ".fileprovider";
    }

    private static Intent mailtoIntent() {
        return new Intent(Intent.ACTION_SENDTO, Uri.parse("mailto:"));
    }

    private static void putNotice(Intent intent, String address, String subject, String body) {
        intent.putExtra(Intent.EXTRA_EMAIL, new String[] { address });
        intent.putExtra(Intent.EXTRA_SUBJECT, subject);
        intent.putExtra(Intent.EXTRA_TEXT, body);
    }

    /**
     * The intents that hand the Notice over, every one aimed at an app that handles mailto:. Many mail apps
     * ignore attachments on a SENDTO, so with photos each mail app gets a SEND or SEND_MULTIPLE made explicit
     * to its package; a gallery or messenger that merely accepts shared images is never offered the Notice.
     * Without photos one SENDTO resolves to mail apps only. An empty list means no mail app can take the photos.
     */
    static List<Intent> buildMailIntents(Context context, String address, String subject, String body, ArrayList<Uri> attachments) {
        List<Intent> intents = new ArrayList<>();
        if (attachments.isEmpty()) {
            Intent intent = mailtoIntent();
            putNotice(intent, address, subject, body);
            intents.add(intent);
            return intents;
        }
        PackageManager packages = context.getPackageManager();
        Set<String> seen = new LinkedHashSet<>();
        for (ResolveInfo info : packages.queryIntentActivities(mailtoIntent(), 0)) seen.add(info.activityInfo.packageName);
        for (String name : seen) {
            Intent intent = new Intent(attachments.size() > 1 ? Intent.ACTION_SEND_MULTIPLE : Intent.ACTION_SEND);
            intent.setType("image/jpeg");
            intent.setPackage(name);
            putNotice(intent, address, subject, body);
            if (attachments.size() == 1) intent.putExtra(Intent.EXTRA_STREAM, attachments.get(0));
            else intent.putParcelableArrayListExtra(Intent.EXTRA_STREAM, attachments);
            if (!packages.queryIntentActivities(intent, 0).isEmpty()) intents.add(intent);
        }
        return intents;
    }

    /** Lets the apps the intents are aimed at read the photos, and no other app. */
    static void grantAttachments(Context context, List<Intent> intents, List<Uri> attachments) {
        for (Intent intent : intents) {
            if (intent.getPackage() == null) continue;
            for (Uri attachment : attachments) {
                context.grantUriPermission(intent.getPackage(), attachment, Intent.FLAG_GRANT_READ_URI_PERMISSION);
            }
        }
    }

    /**
     * Withdraws every photo grant. A mail app may read a photo long after the chooser returned, so this runs
     * on the next share, on clear and at app start (which covers a process that died mid-handoff), not on return.
     */
    static void revokeAll(Context context) {
        context.revokeUriPermission(Uri.parse("content://" + authority(context) + "/notice_mail"), Intent.FLAG_GRANT_READ_URI_PERMISSION);
    }

    static void prepareHandoff(Context context) throws IOException {
        revokeAll(context);
        cleanExpired(context.getCacheDir());
    }

    static void clearHandoff(Context context) throws IOException {
        revokeAll(context);
        File directory = new File(context.getCacheDir(), "notice-mail");
        if (directory.exists()) deleteCopy(directory);
    }

    @PluginMethod
    public void clear(PluginCall call) {
        try {
            clearHandoff(getContext());
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
            prepareHandoff(getContext());
            File directory = new File(getContext().getCacheDir(), "notice-mail/" + UUID.randomUUID());
            if (!directory.mkdirs()) throw new IllegalStateException("mail_cache_unavailable");
            ArrayList<Uri> attachments = new ArrayList<>();
            for (int index = 0; index < photos.length(); index++) {
                byte[] bytes = Base64.decode(photos.getString(index), Base64.DEFAULT);
                if (bytes.length > 8_000_000) throw new IllegalArgumentException("photo_too_large");
                File file = new File(directory, "zgloszenie-" + (index + 1) + ".jpg");
                try (FileOutputStream stream = new FileOutputStream(file)) { stream.write(bytes); }
                attachments.add(FileProvider.getUriForFile(getContext(), authority(getContext()), file));
            }
            List<Intent> intents = buildMailIntents(getContext(), address, subject, body, attachments);
            if (intents.isEmpty()) throw new IllegalStateException("no_mail_app");
            grantAttachments(getContext(), intents, attachments);
            Intent chooser = Intent.createChooser(intents.get(0), "Wybierz aplikację pocztową");
            if (intents.size() > 1) {
                chooser.putExtra(Intent.EXTRA_INITIAL_INTENTS, intents.subList(1, intents.size()).toArray(new Intent[0]));
            }
            startActivityForResult(call, chooser, "mailReturned");
        } catch (Exception error) {
            revokeAll(getContext());
            call.reject("mail_unavailable", error);
        }
    }

    @ActivityCallback
    private void mailReturned(PluginCall call, ActivityResult result) {
        call.resolve();
    }
}
