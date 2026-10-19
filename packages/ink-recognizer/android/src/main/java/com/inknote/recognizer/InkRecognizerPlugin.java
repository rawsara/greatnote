package com.inknote.recognizer;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.android.gms.tasks.Task;
import com.google.android.gms.tasks.Tasks;
import com.google.mlkit.common.MlKitException;
import com.google.mlkit.common.model.DownloadConditions;
import com.google.mlkit.common.model.RemoteModelManager;
import com.google.mlkit.vision.digitalink.DigitalInkRecognition;
import com.google.mlkit.vision.digitalink.DigitalInkRecognitionModel;
import com.google.mlkit.vision.digitalink.DigitalInkRecognitionModelIdentifier;
import com.google.mlkit.vision.digitalink.DigitalInkRecognizer;
import com.google.mlkit.vision.digitalink.DigitalInkRecognizerOptions;
import com.google.mlkit.vision.digitalink.Ink;
import com.google.mlkit.vision.digitalink.RecognitionCandidate;
import com.google.mlkit.vision.digitalink.RecognitionContext;
import com.google.mlkit.vision.digitalink.RecognitionResult;
import com.google.mlkit.vision.digitalink.WritingArea;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONArray;
import org.json.JSONException;

/**
 * 기기 내장 손글씨 인식 (Google ML Kit Digital Ink).
 * 웹 쪽에서 줄 단위로 묶은 획 좌표를 받아 줄마다 후보 문자열을 돌려준다.
 * 인식은 기기 안에서 이뤄지고, 처음 한 번만 언어 모델(약 20MB)을 내려받는다.
 */
@CapacitorPlugin(name = "InkRecognizer")
public class InkRecognizerPlugin extends Plugin {

    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final Map<String, DigitalInkRecognizer> recognizers = new HashMap<>();

    private DigitalInkRecognitionModel model(String language) throws MlKitException {
        DigitalInkRecognitionModelIdentifier id = DigitalInkRecognitionModelIdentifier.fromLanguageTag(language);
        if (id == null) throw new MlKitException("지원하지 않는 언어: " + language, MlKitException.INVALID_ARGUMENT);
        return DigitalInkRecognitionModel.builder(id).build();
    }

    @PluginMethod
    public void info(PluginCall call) {
        worker.execute(() -> {
            JSObject ret = new JSObject();
            ret.put("available", true);
            ret.put("engine", "mlkit");
            JSArray langs = new JSArray();
            langs.put("ko");
            langs.put("en");
            ret.put("languages", langs);
            try {
                ret.put("ready", Tasks.await(RemoteModelManager.getInstance().isModelDownloaded(model("ko"))));
            } catch (Exception e) {
                ret.put("ready", false);
            }
            call.resolve(ret);
        });
    }

    @PluginMethod
    public void prepare(PluginCall call) {
        String language = call.getString("language", "ko");
        worker.execute(() -> {
            try {
                DigitalInkRecognitionModel m = model(language);
                RemoteModelManager mgr = RemoteModelManager.getInstance();
                if (!Tasks.await(mgr.isModelDownloaded(m))) Tasks.await(mgr.download(m, new DownloadConditions.Builder().build()));
                JSObject ret = new JSObject();
                ret.put("ready", true);
                call.resolve(ret);
            } catch (Exception e) {
                call.reject("언어 모델을 내려받지 못했습니다: " + e.getMessage(), e);
            }
        });
    }

    @PluginMethod
    public void recognizeImage(PluginCall call) {
        call.unimplemented("Android 에서는 recognizeStrokes 를 사용합니다");
    }

    @PluginMethod
    public void recognizeStrokes(PluginCall call) {
        String language = call.getString("language", "ko");
        JSArray lines = call.getArray("lines", new JSArray());
        worker.execute(() -> {
            try {
                DigitalInkRecognizer rec = recognizers.get(language);
                if (rec == null) {
                    DigitalInkRecognitionModel m = model(language);
                    if (!Tasks.await(RemoteModelManager.getInstance().isModelDownloaded(m))) {
                        call.reject("언어 모델이 아직 없습니다 (prepare 필요)", "MODEL_MISSING");
                        return;
                    }
                    rec = DigitalInkRecognition.getClient(DigitalInkRecognizerOptions.builder(m).build());
                    recognizers.put(language, rec);
                }
                JSArray out = new JSArray();
                for (int i = 0; i < lines.length(); i++) {
                    org.json.JSONObject line = lines.getJSONObject(i);
                    Ink ink = toInk(line.getJSONArray("strokes"));
                    RecognitionContext ctx = RecognitionContext.builder()
                        .setPreContext("")
                        .setWritingArea(new WritingArea((float) line.optDouble("width", 0), (float) line.optDouble("height", 0)))
                        .build();
                    Task<RecognitionResult> task = rec.recognize(ink, ctx);
                    RecognitionResult result = Tasks.await(task);
                    JSArray cands = new JSArray();
                    for (RecognitionCandidate c : result.getCandidates()) cands.put(c.getText());
                    JSObject item = new JSObject();
                    item.put("candidates", cands);
                    out.put(item);
                }
                JSObject ret = new JSObject();
                ret.put("lines", out);
                call.resolve(ret);
            } catch (Exception e) {
                call.reject("인식 실패: " + e.getMessage(), e);
            }
        });
    }

    private static Ink toInk(JSONArray strokes) throws JSONException {
        Ink.Builder ink = Ink.builder();
        for (int s = 0; s < strokes.length(); s++) {
            JSONArray p = strokes.getJSONArray(s);
            Ink.Stroke.Builder stroke = Ink.Stroke.builder();
            for (int k = 0; k + 2 < p.length(); k += 3) {
                stroke.addPoint(Ink.Point.create((float) p.getDouble(k), (float) p.getDouble(k + 1), p.getLong(k + 2)));
            }
            ink.addStroke(stroke.build());
        }
        return ink.build();
    }

    @Override
    protected void handleOnDestroy() {
        for (DigitalInkRecognizer r : recognizers.values()) r.close();
        worker.shutdown();
    }
}
