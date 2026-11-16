from temba.channels.views import AuthenticatedExternalClaimView


class ClaimView(AuthenticatedExternalClaimView):
    class Form(AuthenticatedExternalClaimView.Form):
        # numbers are always in Indonesia
        country = None

    form_class = Form

    def get_country(self, obj):
        return "Indonesia"

    def get_submitted_country(self, data):
        return "ID"
