package pl.borczuwa.app;

import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Matrix;
import android.media.ExifInterface;
import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;

@CapacitorPlugin(name = "Photos")
public class PhotosPlugin extends Plugin {
    @PluginMethod
    public void decode(PluginCall call) {
        Bitmap bitmap = null;
        Bitmap oriented = null;
        try {
            String base64 = call.getString("base64");
            if (base64 == null) throw new IllegalArgumentException("image_decode_failed");
            byte[] bytes = Base64.decode(base64, Base64.DEFAULT);
            BitmapFactory.Options options = new BitmapFactory.Options();
            options.inJustDecodeBounds = true;
            BitmapFactory.decodeByteArray(bytes, 0, bytes.length, options);
            if (options.outWidth <= 0 || options.outHeight <= 0) throw new IllegalArgumentException("image_decode_failed");
            options.inSampleSize = 1;
            while (((long) Math.max(options.outWidth, options.outHeight) + options.inSampleSize - 1) / options.inSampleSize > 2048) {
                options.inSampleSize *= 2;
            }
            options.inJustDecodeBounds = false;
            options.inScaled = false;
            bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.length, options);
            if (bitmap == null || Math.max(bitmap.getWidth(), bitmap.getHeight()) > 2048) {
                throw new IllegalArgumentException("image_decode_failed");
            }
            int orientation = ExifInterface.ORIENTATION_NORMAL;
            try (ByteArrayInputStream stream = new ByteArrayInputStream(bytes)) {
                orientation = new ExifInterface(stream).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL);
            } catch (IOException ignored) {
                // Formats without readable EXIF keep their decoded orientation.
            }
            Matrix matrix = new Matrix();
            switch (orientation) {
                case ExifInterface.ORIENTATION_FLIP_HORIZONTAL: matrix.setScale(-1, 1); break;
                case ExifInterface.ORIENTATION_ROTATE_180: matrix.setRotate(180); break;
                case ExifInterface.ORIENTATION_FLIP_VERTICAL: matrix.setScale(1, -1); break;
                case ExifInterface.ORIENTATION_TRANSPOSE: matrix.setRotate(90); matrix.postScale(-1, 1); break;
                case ExifInterface.ORIENTATION_ROTATE_90: matrix.setRotate(90); break;
                case ExifInterface.ORIENTATION_TRANSVERSE: matrix.setRotate(-90); matrix.postScale(-1, 1); break;
                case ExifInterface.ORIENTATION_ROTATE_270: matrix.setRotate(-90); break;
            }
            oriented = matrix.isIdentity() ? bitmap : Bitmap.createBitmap(bitmap, 0, 0, bitmap.getWidth(), bitmap.getHeight(), matrix, true);
            ByteArrayOutputStream jpeg = new ByteArrayOutputStream();
            if (!oriented.compress(Bitmap.CompressFormat.JPEG, 80, jpeg)) throw new IllegalStateException("jpeg_encode_failed");
            call.resolve(new JSObject().put("base64", Base64.encodeToString(jpeg.toByteArray(), Base64.NO_WRAP))
                .put("width", oriented.getWidth()).put("height", oriented.getHeight()));
        } catch (Exception error) {
            call.reject("image_decode_failed", error);
        } finally {
            if (oriented != null && oriented != bitmap) oriented.recycle();
            if (bitmap != null) bitmap.recycle();
        }
    }
}
