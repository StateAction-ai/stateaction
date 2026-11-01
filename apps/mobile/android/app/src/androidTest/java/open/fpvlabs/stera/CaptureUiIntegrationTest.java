package open.fpvlabs.stera;

import androidx.test.rule.ActivityTestRule;
import dev.flutter.plugins.integration_test.FlutterTestRunner;
import org.junit.Rule;
import org.junit.runner.RunWith;

/** Runs the real Flutter application entrypoint, widgets and native plugins. */
@RunWith(FlutterTestRunner.class)
public class CaptureUiIntegrationTest {
    @Rule
    public ActivityTestRule<MainActivity> rule =
        new ActivityTestRule<>(MainActivity.class, true, false);
}
