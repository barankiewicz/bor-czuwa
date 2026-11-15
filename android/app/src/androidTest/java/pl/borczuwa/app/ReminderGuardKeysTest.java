package pl.borczuwa.app;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

/**
 * The guard works on the extras the local notifications plugin puts on a tap. These are the plugin's own
 * spellings, the misspelled object key included. If an upgrade changes one, this fails instead of the guard
 * silently inspecting extras that no longer exist.
 */
public class ReminderGuardKeysTest {
    @Test public void theGuardReadsTheExtrasThePluginWrites() {
        assertEquals("LocalNotificationId", ReminderGuard.ID);
        assertEquals("LocalNotficationObject", ReminderGuard.OBJECT);
        assertEquals("LocalNotificationUserAction", ReminderGuard.ACTION);
    }
}
