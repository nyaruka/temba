import requests

from django.conf import settings
from django.contrib.auth.models import AbstractBaseUser, PermissionsMixin, UserManager as AuthUserManager
from django.core.files.base import ContentFile
from django.core.files.storage import storages
from django.db import models
from django.utils import timezone
from django.utils.functional import cached_property
from django.utils.translation import gettext_lazy as _

from temba.utils.fields import UploadToIdPathAndRename
from temba.utils.models.base import TembaUUIDMixin
from temba.utils.uuid import uuid4


class UserManager(AuthUserManager):
    """
    Overrides the default user manager to make email lookups case insensitive
    """

    def get_by_natural_key(self, email: str):
        return self.get(**{f"{self.model.USERNAME_FIELD}__iexact": email})

    def create_user(self, email: str, password: str, **extra_fields):
        """
        Create and save a user with the given email and password.
        """
        email = self.normalize_email(email)
        user = self.model(email=email, **extra_fields)
        user.set_password(password)
        user.save()
        return user

    def create_system_user(self):
        """
        Creates the system user
        """
        user = self.model(email=User.SYSTEM["email"], first_name=User.SYSTEM["first_name"], is_system=True)
        user.save()
        return user


class User(TembaUUIDMixin, AbstractBaseUser, PermissionsMixin):
    SYSTEM = {"email": "system", "first_name": "System"}

    EMAIL_FIELD = "email"
    USERNAME_FIELD = "email"
    REQUIRED_FIELDS = []

    first_name = models.CharField(_("first name"), max_length=150, blank=True)
    last_name = models.CharField(_("last name"), max_length=150, blank=True)
    email = models.EmailField(_("email address"), unique=True)
    language = models.CharField(max_length=8, choices=settings.LANGUAGES, default=settings.DEFAULT_LANGUAGE)
    avatar = models.ImageField(upload_to=UploadToIdPathAndRename("avatars/"), storage=storages["public"], null=True)

    date_joined = models.DateTimeField(default=timezone.now)
    is_system = models.BooleanField(default=False)
    is_staff = models.BooleanField(default=False)
    is_active = models.BooleanField(default=True)

    # optional customer support fields
    external_id = models.CharField(max_length=128, null=True)
    verification_token = models.CharField(max_length=64, null=True)

    objects = UserManager()

    def clean(self):
        super().clean()

        self.email = self.__class__.objects.normalize_email(self.email)

    @classmethod
    def create(cls, email: str, first_name: str, last_name: str, password: str, language: str = None):
        assert not cls.get_by_email(email), "user with this email already exists"

        return cls.objects.create_user(
            email=email,
            first_name=first_name,
            last_name=last_name,
            password=password,
            language=language or settings.DEFAULT_LANGUAGE,
        )

    @classmethod
    def get_or_create(cls, email: str, first_name: str, last_name: str, password: str, language: str = None):
        obj = cls.get_by_email(email)
        if obj:
            obj.first_name = first_name
            obj.last_name = last_name
            obj.save(update_fields=("first_name", "last_name"))
            return obj

        return cls.create(email, first_name, last_name, password=password, language=language)

    @classmethod
    def get_by_email(cls, email: str):
        return cls.objects.filter(email__iexact=email).first()

    @classmethod
    def get_orgs_for_request(cls, request):
        """
        Gets the orgs that the logged in user has a membership of.
        """

        return request.user.orgs.filter(is_active=True).order_by("name")

    @classmethod
    def get_system_user(cls):
        """
        Gets the system user
        """
        return cls.objects.get(email=cls.SYSTEM["email"])

    @property
    def name(self) -> str:
        return self.get_full_name()

    def get_full_name(self):
        """
        Return the first_name plus the last_name, with a space in between.
        """
        full_name = "%s %s" % (self.first_name, self.last_name)
        return full_name.strip()

    def get_orgs(self):
        return self.orgs.filter(is_active=True).order_by("name")

    def get_owned_orgs(self):
        """
        Gets the orgs where this user is the only user.
        """
        owned_orgs = []
        for org in self.get_orgs():
            if not org.users.exclude(id=self.id).exists():
                owned_orgs.append(org)
        return owned_orgs

    def is_verified(self) -> bool:
        """
        Returns whether this user has a verified email address.
        """
        return self.emailaddress_set.filter(primary=True, verified=True).exists()

    def set_verified(self, verified: bool):
        """
        Manually verify or unverify this user's email address.
        """

        self.emailaddress_set.update_or_create(
            email=self.email, defaults={"email": self.email, "primary": True, "verified": verified}
        )

    @property
    def is_mfa_enabled(self) -> bool:
        """
        Returns whether this user has MFA enabled.
        """

        return bool(self.authenticator_set.all())

    def disable_mfa(self):
        """
        Disables this user's MFA.
        """

        self.authenticator_set.all().delete()

    @cached_property
    def is_alpha(self) -> bool:
        return self.groups.filter(name="Alpha").exists()

    @cached_property
    def is_beta(self) -> bool:
        return self.groups.filter(name="Beta").exists()

    def has_org_perm(self, org, permission: str) -> bool:
        """
        Determines if a user has the given permission in the given org.
        """

        # has it innately? e.g. Granter group
        if self.has_perm(permission):
            return True

        role = org.get_user_role(self)
        if not role:
            return False

        return role.has_perm(permission)

    def get_api_tokens(self, org):
        """
        Gets this users active API tokens for the given org
        """
        return self.api_tokens.filter(org=org, is_active=True)

    def as_engine_ref(self) -> dict:
        return {"uuid": str(self.uuid), "name": self.name}

    def as_chat_ref(self) -> dict:
        return {"uuid": str(self.uuid), "name": self.name, "avatar": self.avatar.url if self.avatar else None}

    def fetch_avatar(self, url: str):  # pragma: no cover
        # fetch the avatar from the url and store it locally
        self.avatar.save(f"{self.pk}_profile.jpg", ContentFile(requests.get(url).content), save=True)
        self.save(update_fields=["avatar"])

    def release(self, user):
        """
        Releases this user, and any orgs of which they are the sole owner.
        """
        self.first_name = ""
        self.last_name = ""
        self.email = f"{str(uuid4())}@temba.io"
        self.password = ""
        self.is_active = False
        self.save()

        # cleanup allauth stuff
        self.socialaccount_set.all().delete()
        self.emailaddress_set.all().delete()

        # release any API tokens
        self.api_tokens.update(is_active=False)

        # release any orgs we own
        for org in self.get_owned_orgs():
            org.release(user, release_users=False)

        # remove user from all roles on other orgs
        for org in self.get_orgs():
            org.remove_user(self)

    def __str__(self):
        return self.name or self.email

    class Meta:
        verbose_name = _("user")
        verbose_name_plural = _("users")
