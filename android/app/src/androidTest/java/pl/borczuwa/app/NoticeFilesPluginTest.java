package pl.borczuwa.app;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import android.content.Context;
import android.net.Uri;
import androidx.core.content.FileProvider;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.File;
import java.io.FileOutputStream;
import java.nio.file.Files;
import org.junit.Test;

public class NoticeFilesPluginTest {
    private final Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
    private final byte[] original = "private".getBytes();

    private File privateFile(File directory, String name) throws Exception {
        assertTrue(directory.isDirectory() || directory.mkdirs());
        File file = new File(directory, name);
        try (FileOutputStream stream = new FileOutputStream(file)) { stream.write(original); }
        return file;
    }

    private void assertRefused(Uri target, File file) throws Exception {
        try {
            NoticeFilesPlugin.writeSelected(context, target, "pdf".getBytes());
            fail("write to " + target + " must be refused");
        } catch (Exception expected) { /* refused */ }
        assertArrayEquals("nothing was written to " + file, original, Files.readAllBytes(file.toPath()));
    }

    @Test public void aFileUriIsRefusedAndNothingIsWritten() throws Exception {
        File file = privateFile(context.getFilesDir(), "secret.txt");
        assertRefused(Uri.fromFile(file), file);
    }

    @Test public void theAppsOwnFileProviderIsRefusedAndNothingIsWritten() throws Exception {
        File file = privateFile(new File(context.getCacheDir(), "notice-mail/own"), "mine.jpg");
        Uri own = FileProvider.getUriForFile(context, context.getPackageName() + ".fileprovider", file);
        assertRefused(own, file);
    }

    @Test public void aDocumentProviderUriIsAccepted() {
        Uri downloads = Uri.parse("content://com.android.externalstorage.documents/document/primary%3ADownload%2Fzgloszenie.pdf");
        assertTrue(NoticeFilesPlugin.isDocumentTarget(context, downloads));
    }

    @Test public void aFileUriIsNotADocumentTarget() {
        assertFalse(NoticeFilesPlugin.isDocumentTarget(context, Uri.parse("file:///data/data/pl.borczuwa.app/files/secret.txt")));
    }
}
