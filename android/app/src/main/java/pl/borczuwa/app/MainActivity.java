package pl.borczuwa.app;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.os.Build;
import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(NoticeMailPlugin.class);
        registerPlugin(NoticeFilesPlugin.class);
        registerPlugin(PhotosPlugin.class);
        registerPlugin(CompassPlugin.class);
        registerPlugin(LocationAccessPlugin.class);
        try { NoticeMailPlugin.cleanExpired(getCacheDir()); }
        catch (java.io.IOException error) { android.util.Log.w("NoticeMail", "mail_cache_cleanup_failed", error); }
        super.onCreate(savedInstanceState);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel("draft-reminders", "Szkice", NotificationManager.IMPORTANCE_LOW);
            channel.setSound(null, null);
            channel.enableVibration(false);
            getSystemService(NotificationManager.class).createNotificationChannel(channel);
            NotificationChannel followUp = new NotificationChannel("follow-up-checks", "Sprawdzenie odpowiedzi", NotificationManager.IMPORTANCE_LOW);
            followUp.setSound(null, null);
            followUp.enableVibration(false);
            getSystemService(NotificationManager.class).createNotificationChannel(followUp);
        }
    }
}
